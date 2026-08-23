import Darwin
import Foundation

public struct BridgeConfig: Codable, Equatable, Sendable {
    public var relayURL: String
    public var hostID: String
    public var hostLabel: String
    public var createdAt: Date
    public var credentialBinarySHA256: String?
    public var previousNotifyCommand: [String]?
    public var previousNotifyLine: String?
    public var installedNotifyBinary: String?
    public var notifyConfigBackupFile: String?
    public var notifyConfigBackupSHA256: String?
    public var installedNotifyConfigSHA256: String?
    public var notifyConfigPreviouslyExisted: Bool?

    public init(
        relayURL: String,
        hostID: String,
        hostLabel: String,
        createdAt: Date,
        credentialBinarySHA256: String? = nil,
        previousNotifyCommand: [String]? = nil,
        previousNotifyLine: String? = nil,
        installedNotifyBinary: String? = nil,
        notifyConfigBackupFile: String? = nil,
        notifyConfigBackupSHA256: String? = nil,
        installedNotifyConfigSHA256: String? = nil,
        notifyConfigPreviouslyExisted: Bool? = nil
    ) {
        self.relayURL = relayURL
        self.hostID = hostID
        self.hostLabel = hostLabel
        self.createdAt = createdAt
        self.credentialBinarySHA256 = credentialBinarySHA256
        self.previousNotifyCommand = previousNotifyCommand
        self.previousNotifyLine = previousNotifyLine
        self.installedNotifyBinary = installedNotifyBinary
        self.notifyConfigBackupFile = notifyConfigBackupFile
        self.notifyConfigBackupSHA256 = notifyConfigBackupSHA256
        self.installedNotifyConfigSHA256 = installedNotifyConfigSHA256
        self.notifyConfigPreviouslyExisted = notifyConfigPreviouslyExisted
    }
}

public struct StoredObservation: Codable, Equatable, Sendable {
    public let normalized: NormalizedObservation
    public let source: EventSource
    public let sourcePrecision: SourcePrecision
    public let sourceUpdatedAt: Date
    public let observedAt: Date

    public init(
        normalized: NormalizedObservation,
        source: EventSource,
        sourcePrecision: SourcePrecision,
        sourceUpdatedAt: Date,
        observedAt: Date
    ) {
        self.normalized = normalized
        self.source = source
        self.sourcePrecision = sourcePrecision
        self.sourceUpdatedAt = sourceUpdatedAt
        self.observedAt = observedAt
    }

    private enum CodingKeys: String, CodingKey {
        case normalized
        case source
        case sourcePrecision
        case sourceUpdatedAt
        case observedAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        normalized = try container.decode(NormalizedObservation.self, forKey: .normalized)
        source = try container.decodeIfPresent(EventSource.self, forKey: .source) ?? .appServer
        sourcePrecision = try container.decodeIfPresent(SourcePrecision.self, forKey: .sourcePrecision) ?? .polledStatus
        sourceUpdatedAt = try container.decode(Date.self, forKey: .sourceUpdatedAt)
        observedAt = try container.decodeIfPresent(Date.self, forKey: .observedAt) ?? sourceUpdatedAt
    }
}

public struct QueuedEnvelope: Codable, Equatable, Sendable {
    public let body: IngestRequest
    public let enqueuedAt: Date

    public init(body: IngestRequest, enqueuedAt: Date) {
        self.body = body
        self.enqueuedAt = enqueuedAt
    }
}

public struct BridgeRuntimeState: Codable, Equatable, Sendable {
    public var sequence: UInt64
    public var observations: [String: StoredObservation]
    public var queue: [QueuedEnvelope]
    public var sourceHealth: [String: SourceHealth]
    public var lastHeartbeatAt: Date?

    public init(
        sequence: UInt64 = 0,
        observations: [String: StoredObservation] = [:],
        queue: [QueuedEnvelope] = [],
        sourceHealth: [String: SourceHealth] = [:],
        lastHeartbeatAt: Date? = nil
    ) {
        self.sequence = sequence
        self.observations = observations
        self.queue = queue
        self.sourceHealth = sourceHealth
        self.lastHeartbeatAt = lastHeartbeatAt
    }
}

public enum StateStoreError: LocalizedError {
    case lockFailed
    case missingConfiguration

    public var errorDescription: String? {
        switch self {
        case .lockFailed: return "无法锁定 Bridge 本地状态"
        case .missingConfiguration: return "Bridge 尚未与 Relay 配对"
        }
    }
}

public final class BridgeStateStore: @unchecked Sendable {
    public let rootURL: URL
    private let fileManager: FileManager

    private var configURL: URL { rootURL.appendingPathComponent("config.json") }
    private var runtimeURL: URL { rootURL.appendingPathComponent("runtime.json") }
    private var lockURL: URL { rootURL.appendingPathComponent("state.lock") }

    public init(
        rootURL: URL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/CodexPulse", isDirectory: true),
        fileManager: FileManager = .default
    ) {
        self.rootURL = rootURL
        self.fileManager = fileManager
    }

    public func loadConfig() throws -> BridgeConfig {
        try withLock {
            guard fileManager.fileExists(atPath: configURL.path) else {
                throw StateStoreError.missingConfiguration
            }
            return try ContractJSON.decoder().decode(
                BridgeConfig.self,
                from: Data(contentsOf: configURL)
            )
        }
    }

    public func saveConfig(_ config: BridgeConfig) throws {
        try withLock {
            try write(ContractJSON.encoder().encode(config), to: configURL)
        }
    }

    @discardableResult
    public func updateConfig(_ change: (inout BridgeConfig) throws -> Void) throws -> BridgeConfig {
        try withLock {
            guard fileManager.fileExists(atPath: configURL.path) else {
                throw StateStoreError.missingConfiguration
            }
            var config = try ContractJSON.decoder().decode(
                BridgeConfig.self,
                from: Data(contentsOf: configURL)
            )
            try change(&config)
            try write(ContractJSON.encoder().encode(config), to: configURL)
            return config
        }
    }

    public func loadRuntime() throws -> BridgeRuntimeState {
        try withLock { try readRuntime() }
    }

    @discardableResult
    public func enqueueObservation(
        secret: String,
        observation: AppServerThreadObservation,
        observedAt: Date
    ) throws -> IngestRequest? {
        try withLock {
            var runtime = try readRuntime()
            let next = observation.normalized
            let previous = runtime.observations[observation.threadID]?.normalized

            // A lower-precision idle/notLoaded poll must not erase an
            // authoritative completion before the next snapshot repair.
            if previous?.state == .completed && (next.state == .inactive || next.state == .unknown) {
                pruneObservations(&runtime, now: observedAt)
                try writeRuntime(runtime)
                return nil
            }

            runtime.observations[observation.threadID] = StoredObservation(
                normalized: next,
                source: .appServer,
                sourcePrecision: .polledStatus,
                sourceUpdatedAt: observation.updatedAt,
                observedAt: observedAt
            )
            guard let eventType = TransitionEngine.eventType(previous: previous, next: next) else {
                pruneObservations(&runtime, now: observedAt)
                try writeRuntime(runtime)
                return nil
            }
            runtime.sequence += 1
            let body = EventFactory.make(
                secret: secret,
                threadID: observation.threadID,
                observation: next,
                type: eventType,
                source: .appServer,
                precision: .polledStatus,
                sourceUpdatedAt: observation.updatedAt,
                occurredAt: observedAt,
                observedAt: observedAt,
                sourceIdentity: "\(Int64(observation.updatedAt.timeIntervalSince1970 * 1_000)):\(next.state.rawValue):\(next.attentionReason?.rawValue ?? "none")",
                sequence: runtime.sequence
            )
            append(QueuedEnvelope(body: body, enqueuedAt: observedAt), to: &runtime, now: observedAt)
            pruneObservations(&runtime, now: observedAt)
            try writeRuntime(runtime)
            return body
        }
    }

    @discardableResult
    public func enqueueCompletion(
        secret: String,
        observation: NotifyObservation,
        observedAt: Date,
        source: EventSource = .notify
    ) throws -> IngestRequest {
        try withLock {
            var runtime = try readRuntime()
            runtime.sequence += 1
            runtime.observations[observation.threadID] = StoredObservation(
                normalized: NormalizedObservation(state: .completed, attentionReason: nil),
                source: source,
                sourcePrecision: .event,
                sourceUpdatedAt: observedAt,
                observedAt: observedAt
            )
            let body = EventFactory.completion(
                secret: secret,
                threadID: observation.threadID,
                turnID: observation.turnID,
                observedAt: observedAt,
                sequence: runtime.sequence,
                source: source
            )
            append(QueuedEnvelope(body: body, enqueuedAt: observedAt), to: &runtime, now: observedAt)
            pruneObservations(&runtime, now: observedAt)
            try writeRuntime(runtime)
            return body
        }
    }

    public func makeSnapshotBatch(
        secret: String,
        now: Date,
        limit: Int = 100
    ) throws -> TaskSnapshotBatch {
        try withLock {
            var runtime = try readRuntime()
            pruneObservations(&runtime, now: now)
            let selected = runtime.observations
                .sorted { left, right in left.value.observedAt > right.value.observedAt }
                .prefix(min(max(limit, 0), 100))
            var snapshots: [TaskSnapshot] = []
            snapshots.reserveCapacity(selected.count)
            for (threadID, stored) in selected {
                runtime.sequence += 1
                snapshots.append(
                    TaskSnapshot(
                        taskKey: BridgeCrypto.opaqueTaskKey(secret: secret, threadID: threadID),
                        state: stored.normalized.state,
                        attentionReason: stored.normalized.attentionReason,
                        source: stored.source,
                        sourcePrecision: stored.sourcePrecision,
                        sourceUpdatedAt: stored.sourceUpdatedAt,
                        observedAt: stored.observedAt,
                        expiresAt: nil,
                        revision: runtime.sequence
                    )
                )
            }
            try writeRuntime(runtime)
            return TaskSnapshotBatch(snapshots: snapshots)
        }
    }

    public func nextQueued(now: Date = Date()) throws -> QueuedEnvelope? {
        try withLock {
            var runtime = try readRuntime()
            prune(&runtime, now: now)
            try writeRuntime(runtime)
            return runtime.queue.first
        }
    }

    public func acknowledge(eventID: String) throws {
        try withLock {
            var runtime = try readRuntime()
            runtime.queue.removeAll { $0.body.event.eventId == eventID }
            try writeRuntime(runtime)
        }
    }

    public func queueCount(now: Date = Date()) throws -> Int {
        try withLock {
            var runtime = try readRuntime()
            prune(&runtime, now: now)
            try writeRuntime(runtime)
            return runtime.queue.count
        }
    }

    public func updateSourceHealth(_ health: SourceHealth) throws {
        try withLock {
            var runtime = try readRuntime()
            runtime.sourceHealth[health.source.rawValue] = health
            try writeRuntime(runtime)
        }
    }

    public func markHeartbeat(_ date: Date) throws {
        try withLock {
            var runtime = try readRuntime()
            runtime.lastHeartbeatAt = date
            try writeRuntime(runtime)
        }
    }

    private func append(_ envelope: QueuedEnvelope, to runtime: inout BridgeRuntimeState, now: Date) {
        if !runtime.queue.contains(where: { $0.body.event.eventId == envelope.body.event.eventId }) {
            runtime.queue.append(envelope)
        }
        prune(&runtime, now: now)
        while runtime.queue.count > 1_000 {
            if let lowValue = runtime.queue.firstIndex(where: {
                $0.body.event.type == .taskUpdated || $0.body.event.type == .taskStarted
            }) {
                runtime.queue.remove(at: lowValue)
            } else {
                runtime.queue.removeFirst()
            }
        }
    }

    private func prune(_ runtime: inout BridgeRuntimeState, now: Date) {
        runtime.queue.removeAll { envelope in
            envelope.body.event.occurredAt
                .addingTimeInterval(TimeInterval(envelope.body.event.ttlSeconds)) <= now
        }
    }

    private func pruneObservations(_ runtime: inout BridgeRuntimeState, now: Date) {
        let cutoff = now.addingTimeInterval(-7 * 24 * 60 * 60)
        runtime.observations = runtime.observations.filter { _, stored in
            stored.normalized.state == .running ||
                stored.normalized.state == .needsAttention ||
                stored.observedAt >= cutoff
        }
        if runtime.observations.count > 200 {
            let retained = runtime.observations
                .sorted { left, right in
                    let leftLive = left.value.normalized.state == .running || left.value.normalized.state == .needsAttention
                    let rightLive = right.value.normalized.state == .running || right.value.normalized.state == .needsAttention
                    if leftLive != rightLive { return leftLive }
                    return left.value.observedAt > right.value.observedAt
                }
                .prefix(200)
            runtime.observations = Dictionary(
                uniqueKeysWithValues: retained.map { ($0.key, $0.value) }
            )
        }
    }

    private func readRuntime() throws -> BridgeRuntimeState {
        guard fileManager.fileExists(atPath: runtimeURL.path) else {
            return BridgeRuntimeState()
        }
        return try ContractJSON.decoder().decode(
            BridgeRuntimeState.self,
            from: Data(contentsOf: runtimeURL)
        )
    }

    private func writeRuntime(_ runtime: BridgeRuntimeState) throws {
        try write(ContractJSON.encoder().encode(runtime), to: runtimeURL)
    }

    private func write(_ data: Data, to url: URL) throws {
        try ensureDirectory()
        try data.write(to: url, options: .atomic)
        try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    private func ensureDirectory() throws {
        if !fileManager.fileExists(atPath: rootURL.path) {
            try fileManager.createDirectory(
                at: rootURL,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
        }
    }

    private func withLock<T>(_ operation: () throws -> T) throws -> T {
        try ensureDirectory()
        let descriptor = open(lockURL.path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else { throw StateStoreError.lockFailed }
        defer { close(descriptor) }
        guard flock(descriptor, LOCK_EX) == 0 else { throw StateStoreError.lockFailed }
        defer { flock(descriptor, LOCK_UN) }
        return try operation()
    }
}
