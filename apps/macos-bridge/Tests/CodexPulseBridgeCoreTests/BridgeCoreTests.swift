import XCTest
@testable import CodexPulseBridgeCore

final class BridgeCoreTests: XCTestCase {
    private let secret = Data("host-secret".utf8).base64URLEncodedString()
    private let binarySHA256 = String(repeating: "a", count: 64)

    func testCredentialAccessRequiresPairTimeBinaryFingerprint() throws {
        var config = BridgeConfig(
            relayURL: "https://pulse.example",
            hostID: "host",
            hostLabel: "Mac",
            createdAt: Date()
        )

        XCTAssertThrowsError(
            try BridgeBinaryIdentity.requireCredentialAccess(
                config: config,
                actualSHA256: binarySHA256
            )
        ) { error in
            XCTAssertEqual(error as? BridgeBinaryIdentityError, .fingerprintMissing)
        }

        config.credentialBinarySHA256 = binarySHA256
        XCTAssertNoThrow(
            try BridgeBinaryIdentity.requireCredentialAccess(
                config: config,
                actualSHA256: binarySHA256.uppercased()
            )
        )
        XCTAssertThrowsError(
            try BridgeBinaryIdentity.requireCredentialAccess(
                config: config,
                actualSHA256: String(repeating: "b", count: 64)
            )
        ) { error in
            XCTAssertEqual(error as? BridgeBinaryIdentityError, .fingerprintMismatch)
        }
    }

    func testLegacyConfigDecodesWithoutCredentialFingerprintAndFailsClosed() throws {
        let json = #"{"relayURL":"https://pulse.example","hostID":"host","hostLabel":"Mac","createdAt":"2026-08-12T00:00:00Z"}"#
        let config = try ContractJSON.decoder().decode(BridgeConfig.self, from: Data(json.utf8))
        XCTAssertNil(config.credentialBinarySHA256)
        XCTAssertThrowsError(
            try BridgeBinaryIdentity.requireCredentialAccess(
                config: config,
                actualSHA256: binarySHA256
            )
        )
    }

    func testStateMappingDistinguishesAllRequiredRuntimeValues() {
        XCTAssertEqual(thread(type: "active").normalized.state, .running)
        XCTAssertEqual(
            thread(type: "active", flags: ["waitingOnApproval"]).normalized,
            NormalizedObservation(state: .needsAttention, attentionReason: .approval)
        )
        XCTAssertEqual(
            thread(type: "active", flags: ["waitingOnUserInput"]).normalized,
            NormalizedObservation(state: .needsAttention, attentionReason: .userInput)
        )
        XCTAssertEqual(thread(type: "systemError").normalized.state, .failed)
        XCTAssertEqual(thread(type: "idle").normalized.state, .inactive)
        XCTAssertEqual(thread(type: "notLoaded").normalized.state, .unknown)
    }

    func testNotLoadedAndIdleNeverManufactureCompletion() {
        XCTAssertEqual(
            TransitionEngine.eventType(previous: .init(state: .running, attentionReason: nil), next: .init(state: .inactive, attentionReason: nil)),
            .taskUpdated
        )
        XCTAssertEqual(
            TransitionEngine.eventType(previous: .init(state: .running, attentionReason: nil), next: .init(state: .unknown, attentionReason: nil)),
            .taskUpdated
        )
    }

    func testAttentionTransitionsAreDistinctAndClear() {
        XCTAssertEqual(
            TransitionEngine.eventType(previous: .init(state: .running, attentionReason: nil), next: .init(state: .needsAttention, attentionReason: .approval)),
            .attentionRequired
        )
        XCTAssertEqual(
            TransitionEngine.eventType(previous: .init(state: .needsAttention, attentionReason: .approval), next: .init(state: .running, attentionReason: nil)),
            .attentionCleared
        )
        XCTAssertEqual(
            TransitionEngine.eventType(previous: .init(state: .needsAttention, attentionReason: .userInput), next: .init(state: .inactive, attentionReason: nil)),
            .attentionCleared
        )
    }

    func testIdlePollDoesNotOverwriteAuthoritativeCompletion() {
        XCTAssertNil(
            TransitionEngine.eventType(previous: .init(state: .completed, attentionReason: nil), next: .init(state: .inactive, attentionReason: nil))
        )
        XCTAssertNil(
            TransitionEngine.eventType(previous: .init(state: .completed, attentionReason: nil), next: .init(state: .unknown, attentionReason: nil))
        )
    }

    func testNotifyParserIgnoresSensitiveFields() throws {
        let payload = #"{"type":"agent-turn-complete","thread-id":"thread-private","turn-id":"turn-1","cwd":"/Users/private/repo","input-messages":["secret"],"last-assistant-message":"private"}"#
        let observation = try XCTUnwrap(NotifyObservation.parse(json: payload))
        XCTAssertEqual(observation.threadID, "thread-private")
        XCTAssertEqual(observation.turnID, "turn-1")
    }

    func testNormalizedEventContainsNoRawThreadOrContent() throws {
        let body = EventFactory.completion(
            secret: secret,
            threadID: "raw-thread-private",
            turnID: "turn-private",
            observedAt: Date(timeIntervalSince1970: 1_800_000_000),
            sequence: 1
        )
        let json = String(data: try ContractJSON.encoder().encode(body), encoding: .utf8)!
        XCTAssertFalse(json.contains("raw-thread-private"))
        XCTAssertFalse(json.contains("turn-private"))
        XCTAssertFalse(json.contains("prompt"))
        XCTAssertTrue(body.event.eventId.hasPrefix("evt_"))
        XCTAssertTrue(body.event.taskKey.hasPrefix("tsk_"))
    }

    func testHostSecretMakesTaskIdentityHostScoped() {
        let other = Data("other-host-secret".utf8).base64URLEncodedString()
        XCTAssertNotEqual(
            BridgeCrypto.opaqueTaskKey(secret: secret, threadID: "same-thread"),
            BridgeCrypto.opaqueTaskKey(secret: other, threadID: "same-thread")
        )
    }

    func testQueueDeduplicatesAndExpiresOfflineEvents() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("CodexPulseBridgeTests-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = BridgeStateStore(rootURL: directory)
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let observation = NotifyObservation(
            eventType: "agent-turn-complete",
            threadID: "thread-1",
            turnID: "turn-1"
        )
        _ = try store.enqueueCompletion(secret: secret, observation: observation, observedAt: now)
        _ = try store.enqueueCompletion(secret: secret, observation: observation, observedAt: now)
        XCTAssertEqual(try store.queueCount(now: now), 1)
        XCTAssertNil(try store.nextQueued(now: now.addingTimeInterval(24 * 60 * 60 + 1)))
    }

    func testNotifyInstallerChainsAndRestoresExistingCommand() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("CodexPulseNotifyTests-\(UUID().uuidString)", isDirectory: true)
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
        let configURL = directory.appendingPathComponent("config.toml")
        let original = "notify = [\"/usr/local/bin/existing-notifier\", \"--safe\"]\nmodel = \"gpt\"\n"
        try Data(original.utf8).write(to: configURL)
        let manager = NotifyConfigManager(codexConfigURL: configURL, stateStore: store)
        let binary = URL(
            fileURLWithPath: "/Users/test/Library/Application Support/CodexPulse/bin/codex-pulse-bridge"
        )
        XCTAssertTrue(try manager.install(binaryURL: binary, userConsent: true))
        let installed = try String(contentsOf: configURL)
        XCTAssertTrue(installed.contains(binary.path))
        XCTAssertFalse(installed.contains(#"\/"#))
        XCTAssertEqual(try store.loadConfig().previousNotifyCommand?.first, "/usr/local/bin/existing-notifier")
        let installedConfig = try store.loadConfig()
        let backupName = try XCTUnwrap(installedConfig.notifyConfigBackupFile)
        let backupURL = store.rootURL
            .appendingPathComponent("notify-config-backups", isDirectory: true)
            .appendingPathComponent(backupName)
        XCTAssertEqual(try Data(contentsOf: backupURL), Data(original.utf8))
        XCTAssertEqual(
            installedConfig.notifyConfigBackupSHA256,
            BridgeCrypto.sha256Hex(Data(original.utf8))
        )
        XCTAssertTrue(try manager.uninstall(userConsent: true))
        XCTAssertEqual(try String(contentsOf: configURL), original)
        let clearedConfig = try store.loadConfig()
        XCTAssertNil(clearedConfig.notifyConfigBackupFile)
        XCTAssertNil(clearedConfig.notifyConfigBackupSHA256)
        XCTAssertNil(clearedConfig.notifyConfigPreviouslyExisted)
        XCTAssertFalse(FileManager.default.fileExists(atPath: backupURL.path))
    }

    func testNotifyUninstallRemovesConfigCreatedByInstaller() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("CodexPulseNotifyAbsent-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let store = BridgeStateStore(rootURL: directory.appendingPathComponent("state"))
        try store.saveConfig(
            BridgeConfig(relayURL: "https://pulse.example", hostID: UUID().uuidString, hostLabel: "Mac", createdAt: Date())
        )
        let configURL = directory.appendingPathComponent("missing/config.toml")
        let manager = NotifyConfigManager(codexConfigURL: configURL, stateStore: store)
        XCTAssertTrue(
            try manager.install(
                binaryURL: URL(fileURLWithPath: "/Applications/CodexPulse/codex-pulse-bridge"),
                userConsent: true
            )
        )
        XCTAssertEqual(try store.loadConfig().notifyConfigPreviouslyExisted, false)
        XCTAssertTrue(FileManager.default.fileExists(atPath: configURL.path))
        XCTAssertTrue(try manager.uninstall(userConsent: true))
        XCTAssertFalse(FileManager.default.fileExists(atPath: configURL.path))
    }

    func testNotifyParserRejectsJSONOnlyEscapedSlashes() {
        XCTAssertNil(
            NotifyConfigManager.notifyArray(
                in: #"notify = ["\/Users\/test\/notifier", "turn-ended"]"#
            )
        )
        XCTAssertEqual(
            NotifyConfigManager.notifyArray(
                in: #"notify = ["/Users/test/a#b", "turn-ended"] # preserved comment"#
            ),
            ["/Users/test/a#b", "turn-ended"]
        )
    }

    func testNotifyUninstallReconcilesAnAlreadyRestoredConfig() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("CodexPulseNotifyReconcile-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let store = BridgeStateStore(rootURL: directory.appendingPathComponent("state"))
        try store.saveConfig(
            BridgeConfig(relayURL: "https://pulse.example", hostID: UUID().uuidString, hostLabel: "Mac", createdAt: Date())
        )
        let configURL = directory.appendingPathComponent("config.toml")
        let original = "notify = [\"/usr/local/bin/existing-notifier\", \"--safe\"]\nmodel = \"gpt\"\n"
        try Data(original.utf8).write(to: configURL)
        let manager = NotifyConfigManager(codexConfigURL: configURL, stateStore: store)
        let binary = URL(fileURLWithPath: "/Applications/CodexPulse/codex-pulse-bridge")
        XCTAssertTrue(try manager.install(binaryURL: binary, userConsent: true))

        try Data(original.utf8).write(to: configURL)
        XCTAssertFalse(try manager.uninstall(userConsent: true))
        XCTAssertEqual(try String(contentsOf: configURL), original)
        XCTAssertNil(try store.loadConfig().installedNotifyBinary)
    }

    func testNotifyUninstallPreservesUnrelatedChangesMadeAfterInstall() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("CodexPulseNotifyConcurrent-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let store = BridgeStateStore(rootURL: directory.appendingPathComponent("state"))
        try store.saveConfig(
            BridgeConfig(relayURL: "https://pulse.example", hostID: UUID().uuidString, hostLabel: "Mac", createdAt: Date())
        )
        let configURL = directory.appendingPathComponent("config.toml")
        let original = "notify = [\"/usr/local/bin/existing-notifier\", \"--safe\"]\r\nmodel = \"old\"\r\n"
        try Data(original.utf8).write(to: configURL)
        let manager = NotifyConfigManager(codexConfigURL: configURL, stateStore: store)
        XCTAssertTrue(
            try manager.install(
                binaryURL: URL(fileURLWithPath: "/Applications/CodexPulse/codex-pulse-bridge"),
                userConsent: true
            )
        )
        let changed = try String(contentsOf: configURL)
            .replacingOccurrences(of: "model = \"old\"", with: "model = \"new\"")
        try Data(changed.utf8).write(to: configURL)

        XCTAssertTrue(try manager.uninstall(userConsent: true))
        XCTAssertEqual(
            try String(contentsOf: configURL),
            original.replacingOccurrences(of: "model = \"old\"", with: "model = \"new\"")
        )
    }

    func testNotifyInstallerFailsClosedForMultilineConfiguration() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("CodexPulseNotifyMalformed-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let store = BridgeStateStore(rootURL: directory.appendingPathComponent("state"))
        try store.saveConfig(
            BridgeConfig(relayURL: "https://pulse.example", hostID: UUID().uuidString, hostLabel: "Mac", createdAt: Date())
        )
        let configURL = directory.appendingPathComponent("config.toml")
        let original = "notify = [\n  \"/usr/local/bin/notify\"\n]\n"
        try Data(original.utf8).write(to: configURL)
        let manager = NotifyConfigManager(codexConfigURL: configURL, stateStore: store)
        XCTAssertThrowsError(
            try manager.install(binaryURL: URL(fileURLWithPath: "/tmp/bridge"), userConsent: true)
        )
        XCTAssertEqual(try String(contentsOf: configURL), original)
    }

    private func thread(type: String, flags: [String] = []) -> AppServerThreadObservation {
        AppServerThreadObservation(
            threadID: "thread",
            statusType: type,
            activeFlags: flags,
            updatedAt: Date()
        )
    }
}
