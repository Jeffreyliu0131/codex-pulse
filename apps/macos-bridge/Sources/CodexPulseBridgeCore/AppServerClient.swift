import Foundation

public enum AppServerClientError: LocalizedError {
    case executableNotFound
    case launchFailed
    case disconnected
    case timeout
    case invalidResponse
    case server(String)

    public var errorDescription: String? {
        switch self {
        case .executableNotFound: return "未找到 Codex 可执行文件"
        case .launchFailed: return "Codex App Server 启动失败"
        case .disconnected: return "Codex App Server 已断开"
        case .timeout: return "Codex App Server 响应超时"
        case .invalidResponse: return "Codex App Server 响应格式无法识别"
        case .server(let category): return "Codex App Server 错误：\(category)"
        }
    }
}

public final class AppServerClient: @unchecked Sendable {
    private let condition = NSCondition()
    private var process: Process?
    private var input: Pipe?
    private var output: Pipe?
    private var errors: Pipe?
    private var buffer = Data()
    private var responses: [Int: [String: Any]] = [:]
    private var nextRequestID = 10
    private var disconnected = false

    public init() {}

    public func start() throws {
        condition.lock()
        let alreadyRunning = process?.isRunning == true
        condition.unlock()
        if alreadyRunning { return }
        guard let executable = CodexExecutableLocator.locate() else {
            throw AppServerClientError.executableNotFound
        }

        let process = Process()
        let input = Pipe()
        let output = Pipe()
        let errors = Pipe()
        process.executableURL = executable
        process.arguments = ["app-server"]
        process.standardInput = input
        process.standardOutput = output
        process.standardError = errors

        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if !data.isEmpty { self?.receive(data) }
        }
        errors.fileHandleForReading.readabilityHandler = { handle in
            _ = handle.availableData // Drain diagnostics without logging source payloads.
        }
        process.terminationHandler = { [weak self] _ in
            self?.condition.lock()
            self?.disconnected = true
            self?.condition.broadcast()
            self?.condition.unlock()
        }

        do {
            try process.run()
        } catch {
            throw AppServerClientError.launchFailed
        }

        condition.lock()
        self.process = process
        self.input = input
        self.output = output
        self.errors = errors
        disconnected = false
        condition.unlock()

        let _: [String: Any] = try sendRequest(
            method: "initialize",
            params: [
                "clientInfo": [
                    "name": "codex_pulse_bridge",
                    "title": "CodexPulse Bridge",
                    "version": bridgeVersion
                ]
            ],
            requestID: 1
        )
        try sendNotification(method: "initialized", params: [:])
    }

    public func listThreads(limit: Int = 100) throws -> [AppServerThreadObservation] {
        try start()
        let response: [String: Any] = try sendRequest(
            method: "thread/list",
            params: [
                "archived": false,
                "limit": min(max(limit, 1), 100),
                "sortKey": "recency_at",
                "sortDirection": "desc",
                "sourceKinds": ["vscode"],
                "useStateDbOnly": true
            ]
        )
        guard let result = response["result"] as? [String: Any],
              let rows = result["data"] as? [[String: Any]]
        else { throw AppServerClientError.invalidResponse }

        return rows.compactMap { row in
            guard let threadID = row["id"] as? String,
                  let status = row["status"] as? [String: Any]
            else { return nil }
            let statusType = status["type"] as? String ?? "notLoaded"
            let flags = status["activeFlags"] as? [String] ?? []
            let timestamp = (row["updatedAt"] as? NSNumber)?.doubleValue
                ?? (row["createdAt"] as? NSNumber)?.doubleValue
                ?? Date().timeIntervalSince1970
            let seconds = timestamp > 100_000_000_000 ? timestamp / 1_000 : timestamp
            return AppServerThreadObservation(
                threadID: threadID,
                statusType: statusType,
                activeFlags: flags,
                updatedAt: Date(timeIntervalSince1970: seconds)
            )
        }
    }

    public func stop() {
        condition.lock()
        output?.fileHandleForReading.readabilityHandler = nil
        errors?.fileHandleForReading.readabilityHandler = nil
        let running = process
        process = nil
        input = nil
        output = nil
        errors = nil
        buffer.removeAll()
        responses.removeAll()
        disconnected = true
        condition.broadcast()
        condition.unlock()
        if running?.isRunning == true { running?.terminate() }
    }

    private func sendRequest(
        method: String,
        params: [String: Any],
        requestID suppliedID: Int? = nil
    ) throws -> [String: Any] {
        condition.lock()
        let requestID: Int
        if let suppliedID {
            requestID = suppliedID
        } else {
            nextRequestID += 1
            requestID = nextRequestID
        }
        condition.unlock()

        try write(["id": requestID, "method": method, "params": params])
        let deadline = Date().addingTimeInterval(10)
        condition.lock()
        defer { condition.unlock() }
        while responses[requestID] == nil && !disconnected {
            if !condition.wait(until: deadline) { throw AppServerClientError.timeout }
        }
        if disconnected { throw AppServerClientError.disconnected }
        guard let response = responses.removeValue(forKey: requestID) else {
            throw AppServerClientError.invalidResponse
        }
        if let error = response["error"] as? [String: Any] {
            throw AppServerClientError.server(error["message"] as? String ?? "unknown")
        }
        return response
    }

    private func sendNotification(method: String, params: [String: Any]) throws {
        try write(["method": method, "params": params])
    }

    private func write(_ message: [String: Any]) throws {
        guard JSONSerialization.isValidJSONObject(message) else {
            throw AppServerClientError.invalidResponse
        }
        var data = try JSONSerialization.data(withJSONObject: message)
        data.append(0x0A)
        condition.lock()
        let handle = input?.fileHandleForWriting
        condition.unlock()
        guard let handle else { throw AppServerClientError.disconnected }
        do {
            try handle.write(contentsOf: data)
        } catch {
            throw AppServerClientError.disconnected
        }
    }

    private func receive(_ data: Data) {
        condition.lock()
        buffer.append(data)
        while let newline = buffer.firstIndex(of: 0x0A) {
            let line = Data(buffer[..<newline])
            buffer.removeSubrange(...newline)
            guard !line.isEmpty,
                  let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                  let requestID = (object["id"] as? NSNumber)?.intValue
            else { continue }
            responses[requestID] = object
        }
        condition.broadcast()
        condition.unlock()
    }
}

public enum CodexExecutableLocator {
    public static func locate(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        fileManager: FileManager = .default
    ) -> URL? {
        var candidates: [String] = []
        if let configured = environment["CODEX_EXECUTABLE"], !configured.isEmpty {
            candidates.append(configured)
        }
        candidates.append(contentsOf: [
            "/Applications/ChatGPT.app/Contents/Resources/codex",
            "/Applications/Codex.app/Contents/Resources/codex",
            "/opt/homebrew/bin/codex",
            "/usr/local/bin/codex"
        ])
        return candidates
            .map { URL(fileURLWithPath: $0) }
            .first { fileManager.isExecutableFile(atPath: $0.path) }
    }
}
