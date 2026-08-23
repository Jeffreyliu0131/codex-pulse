import Foundation

public enum RelayClientError: LocalizedError {
    case invalidRelayURL
    case invalidResponse
    case requestFailed(status: Int, code: String)
    case pairingExpired
    case pairingRejected

    public var errorDescription: String? {
        switch self {
        case .invalidRelayURL: return "Relay URL 无效或不是 HTTPS"
        case .invalidResponse: return "Relay 返回了无法识别的响应"
        case .requestFailed(let status, let code): return "Relay 请求失败（\(status): \(code)）"
        case .pairingExpired: return "配对码已过期"
        case .pairingRejected: return "手机端未批准这台主机"
        }
    }
}

public struct PairingCredential: Equatable, Sendable {
    public let relayURL: URL
    public let hostID: String
    public let hostLabel: String
    public let hostSecret: String
}

public final class RelayClient: @unchecked Sendable {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func pair(
        relayURL: URL,
        code: String,
        label: String,
        onStatus: @escaping @Sendable (String) -> Void
    ) async throws -> PairingCredential {
        try Self.validate(relayURL)
        struct ClaimBody: Encodable { let code: String; let label: String }
        struct ClaimResponse: Decodable {
            let pairingId: String
            let claimToken: String
            let status: String
            let expiresAt: String
        }
        let claimData = try ContractJSON.encoder().encode(ClaimBody(code: code, label: label))
        let claim: ClaimResponse = try await request(
            url: endpoint(relayURL, path: "/api/pairings/claim"),
            method: "POST",
            body: claimData,
            acceptedStatus: [200, 202]
        )
        guard let expiresAt = ContractJSON.date(from: claim.expiresAt) else {
            throw RelayClientError.invalidResponse
        }

        onStatus("手机端正在等待你确认主机标签：\(label)")
        while Date() < expiresAt {
            do {
                struct CredentialResponse: Decodable {
                    let status: String
                    let hostId: String?
                    let hostLabel: String?
                    let hostSecret: String?
                    let relayUrl: String?
                }
                let result: CredentialResponse = try await request(
                    url: endpoint(relayURL, path: "/api/pairings/claim"),
                    method: "GET",
                    body: nil,
                    headers: ["x-pulse-claim-token": claim.claimToken],
                    acceptedStatus: [200, 202]
                )
                if result.status == "approved",
                   let hostID = result.hostId,
                   let hostLabel = result.hostLabel,
                   let hostSecret = result.hostSecret,
                   let returnedRelay = result.relayUrl.flatMap(URL.init(string:)) {
                    try Self.validate(returnedRelay)
                    guard Self.sameOrigin(relayURL, returnedRelay) else {
                        throw RelayClientError.invalidResponse
                    }
                    return PairingCredential(
                        relayURL: returnedRelay,
                        hostID: hostID,
                        hostLabel: hostLabel,
                        hostSecret: hostSecret
                    )
                }
            } catch let RelayClientError.requestFailed(status, _) where status == 410 {
                throw RelayClientError.pairingRejected
            }
            try await Task.sleep(for: .seconds(2))
        }
        throw RelayClientError.pairingExpired
    }

    public func flush(
        store: BridgeStateStore,
        config: BridgeConfig,
        secret: String,
        maximum: Int = 50
    ) async throws -> Int {
        guard let relayURL = URL(string: config.relayURL) else {
            throw RelayClientError.invalidRelayURL
        }
        try Self.validate(relayURL)
        var delivered = 0
        while delivered < maximum, let envelope = try store.nextQueued() {
            let data = try ContractJSON.encoder().encode(envelope.body)
            struct Acknowledgement: Decodable {
                let accepted: Bool
                let duplicate: Bool
                let taskId: String
                let acknowledgedSequence: UInt64
            }
            let _: Acknowledgement = try await signedRequest(
                url: endpoint(relayURL, path: "/api/bridge/events"),
                method: "POST",
                body: data,
                hostID: config.hostID,
                secret: secret
            )
            try store.acknowledge(eventID: envelope.body.event.eventId)
            delivered += 1
        }
        return delivered
    }

    public func heartbeat(
        _ heartbeat: HostHeartbeat,
        config: BridgeConfig,
        secret: String
    ) async throws {
        guard let relayURL = URL(string: config.relayURL) else {
            throw RelayClientError.invalidRelayURL
        }
        let data = try ContractJSON.encoder().encode(heartbeat)
        struct Response: Decodable { let accepted: Bool }
        let _: Response = try await signedRequest(
            url: endpoint(relayURL, path: "/api/bridge/heartbeat"),
            method: "POST",
            body: data,
            hostID: config.hostID,
            secret: secret
        )
    }

    public func syncSnapshots(
        _ batch: TaskSnapshotBatch,
        config: BridgeConfig,
        secret: String
    ) async throws -> Int {
        guard let relayURL = URL(string: config.relayURL) else {
            throw RelayClientError.invalidRelayURL
        }
        let data = try ContractJSON.encoder().encode(batch)
        struct Response: Decodable { let accepted: Int }
        let response: Response = try await signedRequest(
            url: endpoint(relayURL, path: "/api/bridge/snapshots"),
            method: "POST",
            body: data,
            hostID: config.hostID,
            secret: secret
        )
        return response.accepted
    }

    private func signedRequest<T: Decodable>(
        url: URL,
        method: String,
        body: Data,
        hostID: String,
        secret: String
    ) async throws -> T {
        try Self.validateRequestURL(url)
        let timestamp = String(Int(Date().timeIntervalSince1970))
        let nonce = BridgeCrypto.randomToken(byteCount: 24)
        let bodyHash = BridgeCrypto.sha256Hex(body)
        let canonical = BridgeCrypto.canonicalRequest(
            method: method,
            path: url.path,
            timestamp: timestamp,
            nonce: nonce,
            bodyHash: bodyHash
        )
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue(hostID, forHTTPHeaderField: "x-pulse-host-id")
        request.setValue(timestamp, forHTTPHeaderField: "x-pulse-timestamp")
        request.setValue(nonce, forHTTPHeaderField: "x-pulse-nonce")
        request.setValue(bodyHash, forHTTPHeaderField: "x-pulse-body-sha256")
        request.setValue(
            BridgeCrypto.hmac(secret: secret, value: canonical),
            forHTTPHeaderField: "x-pulse-signature"
        )
        return try await perform(request: request, acceptedStatus: [200])
    }

    private func request<T: Decodable>(
        url: URL,
        method: String,
        body: Data?,
        headers: [String: String] = [:],
        acceptedStatus: Set<Int> = [200]
    ) async throws -> T {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        request.timeoutInterval = 15
        request.cachePolicy = .reloadIgnoringLocalCacheData
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "content-type") }
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        return try await perform(request: request, acceptedStatus: acceptedStatus)
    }

    private func perform<T: Decodable>(
        request: URLRequest,
        acceptedStatus: Set<Int>
    ) async throws -> T {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw RelayClientError.invalidResponse
        }
        guard acceptedStatus.contains(http.statusCode) else {
            let error = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw RelayClientError.requestFailed(status: http.statusCode, code: error ?? "request_failed")
        }
        do {
            return try ContractJSON.decoder().decode(T.self, from: data)
        } catch {
            throw RelayClientError.invalidResponse
        }
    }

    private func endpoint(_ base: URL, path: String) -> URL {
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        components.path = path
        components.query = nil
        components.fragment = nil
        return components.url!
    }

    private static func validate(_ url: URL) throws {
        try validateRequestURL(url)
        let local = url.host == "localhost" || url.host == "127.0.0.1"
        let rootPath = url.path.isEmpty || url.path == "/"
        guard (url.scheme == "https" || (local && url.scheme == "http")), rootPath else {
            throw RelayClientError.invalidRelayURL
        }
    }

    private static func validateRequestURL(_ url: URL) throws {
        let local = url.host == "localhost" || url.host == "127.0.0.1"
        guard (url.scheme == "https" || (local && url.scheme == "http")),
              url.host?.isEmpty == false,
              url.user == nil,
              url.password == nil,
              url.query == nil,
              url.fragment == nil
        else {
            throw RelayClientError.invalidRelayURL
        }
    }

    private static func sameOrigin(_ left: URL, _ right: URL) -> Bool {
        func normalizedPort(_ url: URL) -> Int? {
            url.port ?? (url.scheme == "https" ? 443 : url.scheme == "http" ? 80 : nil)
        }
        return left.scheme?.lowercased() == right.scheme?.lowercased() &&
            left.host?.lowercased() == right.host?.lowercased() &&
            normalizedPort(left) == normalizedPort(right)
    }
}
