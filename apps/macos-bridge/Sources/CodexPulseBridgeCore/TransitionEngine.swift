import Foundation

public enum TransitionEngine {
    public static func eventType(
        previous: NormalizedObservation?,
        next: NormalizedObservation
    ) -> TaskEventType? {
        guard previous != next else { return nil }

        if next.state == .needsAttention {
            return .attentionRequired
        }
        if previous?.state == .needsAttention && next.state != .failed {
            return .attentionCleared
        }
        if next.state == .failed {
            return .taskFailed
        }
        if next.state == .running {
            return previous == nil || previous?.state == .inactive || previous?.state == .unknown
                ? .taskStarted
                : .taskUpdated
        }

        // notify is the authoritative completion signal. A lower-precision
        // idle/notLoaded poll that arrives immediately afterwards must not
        // replace the completed projection in the Relay.
        if previous?.state == .completed && (next.state == .inactive || next.state == .unknown) {
            return nil
        }

        // idle and notLoaded are observations only. They never manufacture completion.
        return .taskUpdated
    }

    public static func ttlSeconds(for type: TaskEventType) -> Int {
        switch type {
        case .attentionRequired:
            return 15 * 60
        case .taskCompleted, .taskFailed:
            return 24 * 60 * 60
        case .sourceStale:
            return 10 * 60
        case .taskStarted, .attentionCleared, .taskUpdated:
            return 5 * 60
        }
    }
}

public enum EventFactory {
    public static func make(
        secret: String,
        threadID: String,
        observation: NormalizedObservation,
        type: TaskEventType,
        source: EventSource,
        precision: SourcePrecision,
        sourceUpdatedAt: Date,
        occurredAt: Date,
        observedAt: Date,
        sourceIdentity: String,
        sequence: UInt64
    ) -> IngestRequest {
        let taskKey = BridgeCrypto.opaqueTaskKey(secret: secret, threadID: threadID)
        let eventID = BridgeCrypto.eventID(
            secret: secret,
            taskKey: taskKey,
            type: type,
            reason: observation.attentionReason,
            sourceIdentity: sourceIdentity
        )
        let event = TaskEvent(
            eventId: eventID,
            taskKey: taskKey,
            type: type,
            reason: observation.attentionReason,
            occurredAt: occurredAt,
            observedAt: observedAt,
            source: source,
            sourcePrecision: precision,
            sequence: sequence,
            ttlSeconds: TransitionEngine.ttlSeconds(for: type)
        )
        let snapshot = TaskSnapshot(
            taskKey: taskKey,
            state: observation.state,
            attentionReason: observation.attentionReason,
            source: source,
            sourcePrecision: precision,
            sourceUpdatedAt: sourceUpdatedAt,
            observedAt: observedAt,
            expiresAt: nil,
            revision: sequence
        )
        return IngestRequest(event: event, snapshot: snapshot)
    }

    public static func completion(
        secret: String,
        threadID: String,
        turnID: String,
        observedAt: Date,
        sequence: UInt64,
        source: EventSource = .notify
    ) -> IngestRequest {
        make(
            secret: secret,
            threadID: threadID,
            observation: NormalizedObservation(state: .completed, attentionReason: nil),
            type: .taskCompleted,
            source: source,
            precision: .event,
            sourceUpdatedAt: observedAt,
            occurredAt: observedAt,
            observedAt: observedAt,
            sourceIdentity: turnID,
            sequence: sequence
        )
    }
}
