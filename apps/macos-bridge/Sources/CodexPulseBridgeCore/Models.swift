import Foundation

public let bridgeVersion = "0.1.1"

public enum TaskState: String, Codable, Sendable {
    case running
    case needsAttention = "needs_attention"
    case failed
    case completed
    case inactive
    case unknown
}

public enum AttentionReason: String, Codable, Sendable {
    case approval
    case userInput = "user_input"
    case systemError = "system_error"
}

public enum EventSource: String, Codable, Sendable {
    case notify
    case appServer = "app_server"
    case rollout
    case stateDB = "state_db"
    case desktopIPC = "desktop_ipc"
    case remoteCache = "remote_cache"
    case synthetic
}

public enum SourcePrecision: String, Codable, Sendable {
    case event
    case liveStatus = "live_status"
    case polledStatus = "polled_status"
    case cachedSummary = "cached_summary"
}

public enum TaskEventType: String, Codable, Sendable {
    case taskStarted = "task_started"
    case attentionRequired = "attention_required"
    case attentionCleared = "attention_cleared"
    case taskCompleted = "task_completed"
    case taskFailed = "task_failed"
    case taskUpdated = "task_updated"
    case sourceStale = "source_stale"
}

public struct TaskSnapshot: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let taskKey: String
    public let state: TaskState
    public let attentionReason: AttentionReason?
    public let source: EventSource
    public let sourcePrecision: SourcePrecision
    public let sourceUpdatedAt: Date
    public let observedAt: Date
    public let expiresAt: Date?
    public let revision: UInt64

    public init(
        taskKey: String,
        state: TaskState,
        attentionReason: AttentionReason?,
        source: EventSource,
        sourcePrecision: SourcePrecision,
        sourceUpdatedAt: Date,
        observedAt: Date,
        expiresAt: Date?,
        revision: UInt64
    ) {
        self.schemaVersion = 1
        self.taskKey = taskKey
        self.state = state
        self.attentionReason = attentionReason
        self.source = source
        self.sourcePrecision = sourcePrecision
        self.sourceUpdatedAt = sourceUpdatedAt
        self.observedAt = observedAt
        self.expiresAt = expiresAt
        self.revision = revision
    }

    private enum CodingKeys: String, CodingKey {
        case schemaVersion
        case taskKey
        case state
        case attentionReason
        case source
        case sourcePrecision
        case sourceUpdatedAt
        case observedAt
        case expiresAt
        case revision
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(schemaVersion, forKey: .schemaVersion)
        try container.encode(taskKey, forKey: .taskKey)
        try container.encode(state, forKey: .state)
        if let attentionReason {
            try container.encode(attentionReason, forKey: .attentionReason)
        } else {
            try container.encodeNil(forKey: .attentionReason)
        }
        try container.encode(source, forKey: .source)
        try container.encode(sourcePrecision, forKey: .sourcePrecision)
        try container.encode(sourceUpdatedAt, forKey: .sourceUpdatedAt)
        try container.encode(observedAt, forKey: .observedAt)
        if let expiresAt {
            try container.encode(expiresAt, forKey: .expiresAt)
        } else {
            try container.encodeNil(forKey: .expiresAt)
        }
        try container.encode(revision, forKey: .revision)
    }
}

public struct TaskEvent: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let eventId: String
    public let taskKey: String
    public let type: TaskEventType
    public let reason: AttentionReason?
    public let occurredAt: Date
    public let observedAt: Date
    public let source: EventSource
    public let sourcePrecision: SourcePrecision
    public let sequence: UInt64
    public let ttlSeconds: Int

    public init(
        eventId: String,
        taskKey: String,
        type: TaskEventType,
        reason: AttentionReason?,
        occurredAt: Date,
        observedAt: Date,
        source: EventSource,
        sourcePrecision: SourcePrecision,
        sequence: UInt64,
        ttlSeconds: Int
    ) {
        self.schemaVersion = 1
        self.eventId = eventId
        self.taskKey = taskKey
        self.type = type
        self.reason = reason
        self.occurredAt = occurredAt
        self.observedAt = observedAt
        self.source = source
        self.sourcePrecision = sourcePrecision
        self.sequence = sequence
        self.ttlSeconds = ttlSeconds
    }

    private enum CodingKeys: String, CodingKey {
        case schemaVersion
        case eventId
        case taskKey
        case type
        case reason
        case occurredAt
        case observedAt
        case source
        case sourcePrecision
        case sequence
        case ttlSeconds
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(schemaVersion, forKey: .schemaVersion)
        try container.encode(eventId, forKey: .eventId)
        try container.encode(taskKey, forKey: .taskKey)
        try container.encode(type, forKey: .type)
        if let reason {
            try container.encode(reason, forKey: .reason)
        } else {
            try container.encodeNil(forKey: .reason)
        }
        try container.encode(occurredAt, forKey: .occurredAt)
        try container.encode(observedAt, forKey: .observedAt)
        try container.encode(source, forKey: .source)
        try container.encode(sourcePrecision, forKey: .sourcePrecision)
        try container.encode(sequence, forKey: .sequence)
        try container.encode(ttlSeconds, forKey: .ttlSeconds)
    }
}

public struct IngestRequest: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let event: TaskEvent
    public let snapshot: TaskSnapshot

    public init(event: TaskEvent, snapshot: TaskSnapshot) {
        self.schemaVersion = 1
        self.event = event
        self.snapshot = snapshot
    }
}

public struct TaskSnapshotBatch: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let snapshots: [TaskSnapshot]

    public init(snapshots: [TaskSnapshot]) {
        self.schemaVersion = 1
        self.snapshots = snapshots
    }
}

public struct SourceHealth: Codable, Equatable, Sendable {
    public let source: EventSource
    public let healthy: Bool
    public let lastSuccessAt: Date?
    public let errorCategory: String?

    public init(
        source: EventSource,
        healthy: Bool,
        lastSuccessAt: Date?,
        errorCategory: String?
    ) {
        self.source = source
        self.healthy = healthy
        self.lastSuccessAt = lastSuccessAt
        self.errorCategory = errorCategory
    }

    private enum CodingKeys: String, CodingKey {
        case source
        case healthy
        case lastSuccessAt
        case errorCategory
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(source, forKey: .source)
        try container.encode(healthy, forKey: .healthy)
        if let lastSuccessAt {
            try container.encode(lastSuccessAt, forKey: .lastSuccessAt)
        } else {
            try container.encodeNil(forKey: .lastSuccessAt)
        }
        if let errorCategory {
            try container.encode(errorCategory, forKey: .errorCategory)
        } else {
            try container.encodeNil(forKey: .errorCategory)
        }
    }
}

public struct HostHeartbeat: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let observedAt: Date
    public let bridgeVersion: String
    public let sources: [SourceHealth]
    public let queuedEventCount: Int

    public init(observedAt: Date, sources: [SourceHealth], queuedEventCount: Int) {
        self.schemaVersion = 1
        self.observedAt = observedAt
        self.bridgeVersion = CodexPulseBridgeCore.bridgeVersion
        self.sources = sources
        self.queuedEventCount = queuedEventCount
    }
}

public struct NormalizedObservation: Codable, Equatable, Sendable {
    public let state: TaskState
    public let attentionReason: AttentionReason?

    public init(state: TaskState, attentionReason: AttentionReason?) {
        self.state = state
        self.attentionReason = attentionReason
    }
}

public struct AppServerThreadObservation: Equatable, Sendable {
    public let threadID: String
    public let statusType: String
    public let activeFlags: [String]
    public let updatedAt: Date

    public init(threadID: String, statusType: String, activeFlags: [String], updatedAt: Date) {
        self.threadID = threadID
        self.statusType = statusType
        self.activeFlags = activeFlags
        self.updatedAt = updatedAt
    }

    public var normalized: NormalizedObservation {
        switch statusType {
        case "active" where activeFlags.contains("waitingOnApproval"):
            return NormalizedObservation(state: .needsAttention, attentionReason: .approval)
        case "active" where activeFlags.contains("waitingOnUserInput"):
            return NormalizedObservation(state: .needsAttention, attentionReason: .userInput)
        case "active":
            return NormalizedObservation(state: .running, attentionReason: nil)
        case "systemError":
            return NormalizedObservation(state: .failed, attentionReason: .systemError)
        case "idle":
            return NormalizedObservation(state: .inactive, attentionReason: nil)
        case "notLoaded":
            return NormalizedObservation(state: .unknown, attentionReason: nil)
        default:
            return NormalizedObservation(state: .unknown, attentionReason: nil)
        }
    }
}

public struct NotifyObservation: Equatable, Sendable {
    public let eventType: String
    public let threadID: String
    public let turnID: String

    public init(eventType: String, threadID: String, turnID: String) {
        self.eventType = eventType
        self.threadID = threadID
        self.turnID = turnID
    }

    public static func parse(json: String) -> NotifyObservation? {
        guard let data = json.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }

        func value(_ keys: [String]) -> String? {
            for key in keys {
                if let raw = object[key] as? String,
                   !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    return raw
                }
            }
            return nil
        }

        guard let threadID = value(["thread-id", "thread_id", "threadId"]),
              let turnID = value(["turn-id", "turn_id", "turnId"])
        else { return nil }
        return NotifyObservation(
            eventType: value(["type", "event"]) ?? "agent-turn-complete",
            threadID: threadID,
            turnID: turnID
        )
    }
}

public enum ContractJSON {
    public static func date(from value: String) -> Date? {
        formatter.date(from: value) ?? formatterWithoutFractionalSeconds.date(from: value)
    }

    public static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(Self.formatter.string(from: date))
        }
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }

    public static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            guard let date = Self.date(from: value) else {
                throw DecodingError.dataCorruptedError(
                    in: container,
                    debugDescription: "Invalid ISO 8601 timestamp"
                )
            }
            return date
        }
        return decoder
    }

    private static let formatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let formatterWithoutFractionalSeconds: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()
}
