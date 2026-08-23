import CodexPulseBridgeCore
import Darwin
import Foundation

private enum SelfTestFailure: LocalizedError {
    case assertion(String)

    var errorDescription: String? {
        switch self {
        case .assertion(let message): return message
        }
    }
}

private final class PairingURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host == "pulse.example"
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard let url = request.url else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }
        let status: Int
        let body: String
        if url.path == "/api/pairings/claim" && request.httpMethod == "POST" {
            status = 202
            body = #"{"pairingId":"00000000-0000-4000-8000-000000000001","claimToken":"claim_token_abcdefghijklmnopqrstuvwxyz123456","status":"pending","expiresAt":"2099-01-01T00:00:00Z"}"#
        } else if url.path == "/api/pairings/claim" {
            status = 200
            body = #"{"status":"approved","hostId":"00000000-0000-4000-8000-000000000002","hostLabel":"Test Mac","hostSecret":"host_secret_abcdefghijklmnopqrstuvwxyz123456","relayUrl":"https://pulse.example"}"#
        } else if url.path == "/api/bridge/events" {
            status = 200
            body = #"{"accepted":true,"duplicate":false,"taskId":"00000000-0000-4000-8000-000000000003","acknowledgedSequence":1}"#
        } else {
            status = 404
            body = #"{"error":"not_found"}"#
        }
        let response = HTTPURLResponse(
            url: url,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

@main
struct CodexPulseBridgeSelfTest {
    static func main() async {
        do {
            try await run()
            print("CodexPulse Bridge self-test: 25 checks passed")
        } catch {
            FileHandle.standardError.write(Data("CodexPulse Bridge self-test failed: \(error.localizedDescription)\n".utf8))
            Darwin.exit(1)
        }
    }

    private static func run() async throws {
        let secret = Data("host-secret".utf8).base64URLEncodedString()

        try check(thread(type: "active").normalized.state == .running, "active mapping")
        try check(
            thread(type: "active", flags: ["waitingOnApproval"]).normalized ==
                NormalizedObservation(state: .needsAttention, attentionReason: .approval),
            "approval mapping"
        )
        try check(
            thread(type: "active", flags: ["waitingOnUserInput"]).normalized ==
                NormalizedObservation(state: .needsAttention, attentionReason: .userInput),
            "user-input mapping"
        )
        try check(thread(type: "systemError").normalized.state == .failed, "failure mapping")
        try check(
            TransitionEngine.eventType(
                previous: .init(state: .running, attentionReason: nil),
                next: .init(state: .unknown, attentionReason: nil)
            ) != .taskCompleted,
            "notLoaded never completes"
        )
        try check(
            TransitionEngine.eventType(
                previous: .init(state: .completed, attentionReason: nil),
                next: .init(state: .inactive, attentionReason: nil)
            ) == nil,
            "idle poll preserves completion"
        )

        let payload = #"{"type":"agent-turn-complete","thread-id":"thread-private","turn-id":"turn-1","cwd":"/Users/private/repo","input-messages":["secret"],"last-assistant-message":"private"}"#
        let notify = try require(NotifyObservation.parse(json: payload), "notify parser")
        let body = EventFactory.completion(
            secret: secret,
            threadID: notify.threadID,
            turnID: notify.turnID,
            observedAt: Date(timeIntervalSince1970: 1_800_000_000),
            sequence: 1
        )
        let serialized = String(data: try ContractJSON.encoder().encode(body), encoding: .utf8) ?? ""
        try check(!serialized.contains("thread-private") && !serialized.contains("secret"), "redaction")
        try check(
            serialized.contains("\"reason\":null") &&
                serialized.contains("\"attentionReason\":null") &&
                serialized.contains("\"expiresAt\":null"),
            "nullable contract keys are explicit"
        )

        let hmacSecret = Data("host-secret-value".utf8).base64URLEncodedString()
        let canonical = "POST\n/api/bridge/events\n1786435200\nnonce_nonce_nonce_3\nbody-hash"
        try check(
            BridgeCrypto.hmac(secret: hmacSecret, value: canonical) ==
                "06qLRsrV66kdEOOTE0mMhmEwnGEObagS_0MEB0Z8TK4",
            "cross-language HMAC vector"
        )

        try check(ContractJSON.date(from: "2026-08-11T08:00:00Z") != nil, "ISO date fallback")
        try binaryIdentityGuard()
        try await pairingAcceptsAcceptedResponse()
        try await signedEventEndpointAcceptsPath(secret: secret)
        try queueAndNotifyRollback(secret: secret)
    }

    private static func binaryIdentityGuard() throws {
        let current = String(repeating: "a", count: 64)
        let legacyJSON = #"{"relayURL":"https://pulse.example","hostID":"host","hostLabel":"Test Mac","createdAt":"2026-08-12T00:00:00Z"}"#
        let legacyConfig = try ContractJSON.decoder().decode(
            BridgeConfig.self,
            from: Data(legacyJSON.utf8)
        )
        try check(legacyConfig.credentialBinarySHA256 == nil, "legacy config decodes without fingerprint")

        var config = BridgeConfig(
            relayURL: "https://pulse.example",
            hostID: "host",
            hostLabel: "Test Mac",
            createdAt: Date()
        )
        do {
            try BridgeBinaryIdentity.requireCredentialAccess(config: config, actualSHA256: current)
            throw SelfTestFailure.assertion("missing binary fingerprint fails closed")
        } catch let error as BridgeBinaryIdentityError {
            try check(error == .fingerprintMissing, "missing binary fingerprint fails closed")
        }

        config.credentialBinarySHA256 = current
        try BridgeBinaryIdentity.requireCredentialAccess(
            config: config,
            actualSHA256: current.uppercased()
        )
        try check(true, "matching binary fingerprint allows credential access")

        do {
            try BridgeBinaryIdentity.requireCredentialAccess(
                config: config,
                actualSHA256: String(repeating: "b", count: 64)
            )
            throw SelfTestFailure.assertion("changed binary fingerprint fails closed")
        } catch let error as BridgeBinaryIdentityError {
            try check(error == .fingerprintMismatch, "changed binary fingerprint fails closed")
        }
    }

    private static func pairingAcceptsAcceptedResponse() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [PairingURLProtocol.self]
        let credential = try await RelayClient(session: URLSession(configuration: configuration)).pair(
            relayURL: URL(string: "https://pulse.example")!,
            code: "12345678",
            label: "Test Mac",
            onStatus: { _ in }
        )
        try check(credential.hostLabel == "Test Mac", "pairing accepts HTTP 202")
    }

    private static func signedEventEndpointAcceptsPath(secret: String) async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("CodexPulseRelaySelfTest-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = BridgeStateStore(rootURL: directory)
        let config = BridgeConfig(
            relayURL: "https://pulse.example",
            hostID: "00000000-0000-4000-8000-000000000002",
            hostLabel: "Test Mac",
            createdAt: Date()
        )
        try store.saveConfig(config)
        _ = try store.enqueueCompletion(
            secret: secret,
            observation: NotifyObservation(
                eventType: "agent-turn-complete",
                threadID: "relay-self-test",
                turnID: "relay-turn"
            ),
            observedAt: Date()
        )
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [PairingURLProtocol.self]
        let delivered = try await RelayClient(session: URLSession(configuration: configuration)).flush(
            store: store,
            config: config,
            secret: secret
        )
        try check(delivered == 1 && (try store.queueCount()) == 0, "signed endpoint accepts API path")
    }

    private static func queueAndNotifyRollback(secret: String) throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("CodexPulseSelfTest-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        let store = BridgeStateStore(rootURL: directory.appendingPathComponent("state"))
        try store.saveConfig(
            BridgeConfig(
                relayURL: "https://pulse.example",
                hostID: UUID().uuidString,
                hostLabel: "Mac mini",
                createdAt: Date()
            )
        )
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let observation = NotifyObservation(
            eventType: "agent-turn-complete",
            threadID: "thread-1",
            turnID: "turn-1"
        )
        let completion = try store.enqueueCompletion(secret: secret, observation: observation, observedAt: now)
        _ = try store.enqueueCompletion(secret: secret, observation: observation, observedAt: now)
        try check(try store.queueCount(now: now) == 1, "queue dedupe")

        let lowerPrecisionIdle = AppServerThreadObservation(
            threadID: observation.threadID,
            statusType: "idle",
            activeFlags: [],
            updatedAt: now.addingTimeInterval(1)
        )
        _ = try store.enqueueObservation(
            secret: secret,
            observation: lowerPrecisionIdle,
            observedAt: now.addingTimeInterval(1)
        )
        let preserved = try store.loadRuntime().observations[observation.threadID]
        try check(
            preserved?.normalized.state == .completed && preserved?.source == .notify,
            "notify completion survives lower-precision idle poll"
        )

        let snapshot = try require(
            store.makeSnapshotBatch(secret: secret, now: now.addingTimeInterval(1)).snapshots.first {
                $0.taskKey == completion.snapshot.taskKey
            },
            "completion snapshot repair"
        )
        try check(
            snapshot.state == .completed && snapshot.source == .notify && snapshot.sourcePrecision == .event,
            "snapshot preserves authoritative completion source"
        )

        let oldSourceTime = now.addingTimeInterval(-3_600)
        let observedTime = now.addingTimeInterval(2)
        let active = AppServerThreadObservation(
            threadID: "thread-2",
            statusType: "active",
            activeFlags: [],
            updatedAt: oldSourceTime
        )
        let activeBody = try require(
            store.enqueueObservation(secret: secret, observation: active, observedAt: observedTime),
            "active observation event"
        )
        try check(
            activeBody.event.occurredAt == observedTime && activeBody.snapshot.sourceUpdatedAt == oldSourceTime,
            "event occurrence is separate from source update time"
        )

        let configURL = directory.appendingPathComponent("config.toml")
        let original = "notify = [\"/usr/local/bin/existing-notifier\", \"--safe\"]\nmodel = \"gpt\"\n"
        try Data(original.utf8).write(to: configURL)
        let manager = NotifyConfigManager(codexConfigURL: configURL, stateStore: store)
        let binary = URL(
            fileURLWithPath: "/Users/test/Library/Application Support/CodexPulse/bin/codex-pulse-bridge"
        )
        _ = try manager.install(binaryURL: binary, userConsent: true)
        let installed = try String(contentsOf: configURL, encoding: .utf8)
        try check(installed.contains(binary.path) && !installed.contains(#"\/"#), "TOML path escaping")
        try check(
            NotifyConfigManager.notifyArray(
                in: #"notify = ["\/Users\/test\/notifier", "turn-ended"]"#
            ) == nil,
            "JSON-only slash escape is rejected"
        )
        _ = try manager.uninstall(userConsent: true)
        try check(try String(contentsOf: configURL, encoding: .utf8) == original, "notify rollback")

        _ = try manager.install(binaryURL: binary, userConsent: true)
        try Data(original.utf8).write(to: configURL)
        try check(try manager.uninstall(userConsent: true) == false, "stale install state reconciliation")

        try FileManager.default.removeItem(at: configURL)
        _ = try manager.install(binaryURL: binary, userConsent: true)
        _ = try manager.uninstall(userConsent: true)
        let cleared = try store.loadConfig()
        try check(
            !FileManager.default.fileExists(atPath: configURL.path) &&
                cleared.notifyConfigBackupFile == nil &&
                cleared.notifyConfigBackupSHA256 == nil &&
                cleared.notifyConfigPreviouslyExisted == nil,
            "installer-created config is removed with recovery metadata"
        )
    }

    private static func check(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
        guard try condition() else { throw SelfTestFailure.assertion(message) }
    }

    private static func require<T>(_ value: T?, _ message: String) throws -> T {
        guard let value else { throw SelfTestFailure.assertion(message) }
        return value
    }

    private static func thread(type: String, flags: [String] = []) -> AppServerThreadObservation {
        AppServerThreadObservation(
            threadID: "thread",
            statusType: type,
            activeFlags: flags,
            updatedAt: Date()
        )
    }
}
