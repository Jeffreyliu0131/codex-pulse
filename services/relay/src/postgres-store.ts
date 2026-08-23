import { randomUUID } from "node:crypto";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import type { EventType, IngestRequest, SnapshotBatch, TaskPreferences } from "@codexpulse/contracts";
import { isExpired, shouldNotify, shouldRetryTransientPush } from "./domain.ts";
import type {
  DashboardView,
  HostSecretRecord,
  IngestResult,
  PairingView,
  PushRecord,
  RelayConfig,
  RelayStore,
} from "./types.ts";

type Row = Record<string, unknown>;

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function nullableIso(value: unknown): string | null {
  return value == null ? null : iso(value);
}

function integer(value: unknown): number {
  return typeof value === "number" ? value : Number.parseInt(String(value), 10);
}

function jsonArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export class PostgresStore implements RelayStore {
  readonly #sql: NeonQueryFunction<false, false>;

  constructor(databaseUrl: string, sql?: NeonQueryFunction<false, false>) {
    this.#sql = sql ?? neon(databaseUrl);
  }

  async ping(): Promise<void> {
    await this.#sql`SELECT 1 AS ok`;
  }

  async recordRateLimitAttempt(scope: string, fingerprint: string, now: Date): Promise<number> {
    await this.#sql`
      INSERT INTO rate_limit_attempts (scope, fingerprint, attempted_at)
      VALUES (${scope}, ${fingerprint}, ${now.toISOString()})
    `;
    const rows = await this.#sql`
      SELECT count(*)::integer AS count
      FROM rate_limit_attempts
      WHERE scope = ${scope}
        AND fingerprint = ${fingerprint}
        AND attempted_at > ${new Date(now.getTime() - 10 * 60 * 1000).toISOString()}
    `;
    return integer(rows[0]?.count ?? 0);
  }

  async createPairing(input: {
    id: string;
    codeHash: string;
    expiresAt: Date;
    now: Date;
  }): Promise<void> {
    await this.#sql`
      INSERT INTO pairing_sessions (
        id, code_hash, status, expires_at, created_at, updated_at
      ) VALUES (
        ${input.id}, ${input.codeHash}, 'created', ${input.expiresAt.toISOString()},
        ${input.now.toISOString()}, ${input.now.toISOString()}
      )
    `;
  }

  async claimPairing(input: {
    codeHash: string;
    hostId: string;
    hostLabel: string;
    secretCiphertext: string;
    claimTokenHash: string;
    now: Date;
  }): Promise<{ id: string; expiresAt: string } | null> {
    const rows = await this.#sql`
      WITH valid_pairing AS (
        SELECT id, expires_at
        FROM pairing_sessions
        WHERE code_hash = ${input.codeHash}
          AND status = 'created'
          AND expires_at > ${input.now.toISOString()}
        LIMIT 1
      ), inserted_host AS (
        INSERT INTO hosts (id, label, secret_ciphertext, created_at)
        SELECT ${input.hostId}, ${input.hostLabel}, ${input.secretCiphertext}, ${input.now.toISOString()}
        FROM valid_pairing
        RETURNING id
      )
      UPDATE pairing_sessions AS pairing
      SET status = 'claimed',
          claimed_label = ${input.hostLabel},
          claimed_host_id = ${input.hostId},
          claim_token_hash = ${input.claimTokenHash},
          updated_at = ${input.now.toISOString()}
      FROM inserted_host
      WHERE pairing.id = (SELECT id FROM valid_pairing)
        AND pairing.status = 'created'
      RETURNING pairing.id, pairing.expires_at
    `;
    const row = rows[0];
    return row ? { id: String(row.id), expiresAt: iso(row.expires_at) } : null;
  }

  async getPairingClaim(claimTokenHash: string, now: Date): Promise<{
    pairingId: string;
    status: PairingView["status"];
    hostId: string;
    hostLabel: string;
    secretCiphertext: string;
    expiresAt: string;
    credentialDeliveredAt: string | null;
  } | null> {
    const rows = await this.#sql`
      SELECT pairing.id AS pairing_id,
             pairing.status,
             pairing.expires_at,
             pairing.credential_delivered_at,
             host.id AS host_id,
             host.label AS host_label,
             host.secret_ciphertext
      FROM pairing_sessions AS pairing
      JOIN hosts AS host ON host.id = pairing.claimed_host_id
      WHERE pairing.claim_token_hash = ${claimTokenHash}
        AND pairing.expires_at > ${now.toISOString()}
        AND pairing.status IN ('claimed', 'approved', 'consumed')
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      pairingId: String(row.pairing_id),
      status: String(row.status) as PairingView["status"],
      hostId: String(row.host_id),
      hostLabel: String(row.host_label),
      secretCiphertext: String(row.secret_ciphertext),
      expiresAt: iso(row.expires_at),
      credentialDeliveredAt: nullableIso(row.credential_delivered_at),
    };
  }

  async markCredentialDelivered(pairingId: string, now: Date): Promise<void> {
    await this.#sql`
      UPDATE pairing_sessions
      SET status = 'consumed',
          credential_delivered_at = COALESCE(credential_delivered_at, ${now.toISOString()}),
          updated_at = ${now.toISOString()}
      WHERE id = ${pairingId}
        AND status IN ('approved', 'consumed')
    `;
  }

  async approvePairing(pairingId: string, now: Date, maxHosts: number): Promise<boolean> {
    const countRows = await this.#sql`
      SELECT count(*)::integer AS count
      FROM hosts
      WHERE approved_at IS NOT NULL AND revoked_at IS NULL
    `;
    if (integer(countRows[0]?.count ?? 0) >= maxHosts) return false;

    const rows = await this.#sql`
      UPDATE pairing_sessions
      SET status = 'approved', updated_at = ${now.toISOString()}
      WHERE id = ${pairingId}
        AND status = 'claimed'
        AND expires_at > ${now.toISOString()}
      RETURNING claimed_host_id
    `;
    const hostId = rows[0]?.claimed_host_id;
    if (!hostId) return false;
    await this.#sql`
      UPDATE hosts
      SET approved_at = ${now.toISOString()}
      WHERE id = ${String(hostId)} AND revoked_at IS NULL
    `;
    await this.audit("host_approved", String(hostId), now);
    return true;
  }

  async rejectPairing(pairingId: string, now: Date): Promise<boolean> {
    const rows = await this.#sql`
      UPDATE pairing_sessions
      SET status = 'rejected', updated_at = ${now.toISOString()}
      WHERE id = ${pairingId}
        AND status IN ('created', 'claimed')
      RETURNING claimed_host_id
    `;
    if (rows.length === 0) return false;
    const hostId = rows[0]?.claimed_host_id;
    if (hostId) {
      await this.#sql`
        UPDATE hosts SET revoked_at = ${now.toISOString()} WHERE id = ${String(hostId)}
      `;
    }
    return true;
  }

  async dashboard(now: Date, limits: RelayConfig["limits"]): Promise<DashboardView> {
    const recentCutoff = new Date(now.getTime() - limits.retentionDays * 86_400_000);
    const [hostRows, taskRows, eventRows, pairingRows, subscriptionRows] = await Promise.all([
      this.#sql`
        SELECT id, label, created_at, approved_at, last_seen_at, revoked_at,
               bridge_version, queued_event_count, source_health
        FROM hosts
        WHERE approved_at IS NOT NULL AND revoked_at IS NULL
        ORDER BY created_at ASC
      `,
      this.#sql`
        SELECT task.id, task.host_id, host.label AS host_label, task.alias, task.state,
               task.attention_reason, task.source, task.source_precision,
               task.source_updated_at, task.observed_at, task.relay_received_at,
               task.unread, task.muted, task.notify_on
        FROM tasks AS task
        JOIN hosts AS host ON host.id = task.host_id
        WHERE task.observed_at >= ${recentCutoff.toISOString()}
          AND host.revoked_at IS NULL
        ORDER BY
          CASE task.state
            WHEN 'needs_attention' THEN 0
            WHEN 'failed' THEN 1
            WHEN 'running' THEN 2
            WHEN 'completed' THEN 3
            WHEN 'inactive' THEN 4
            ELSE 5
          END,
          task.observed_at DESC
        LIMIT ${limits.tasks}
      `,
      this.#sql`
        SELECT event.event_id, event.task_id, event.host_id, host.label AS host_label,
               task.alias AS task_alias, event.type, event.reason, event.occurred_at,
               event.observed_at, event.received_at, event.source,
               event.source_precision, event.unread, event.push_attempted_at,
               event.push_accepted_at, event.opened_at, event.push_attempt_count,
               event.push_error_category
        FROM events AS event
        JOIN hosts AS host ON host.id = event.host_id
        JOIN tasks AS task ON task.id = event.task_id
        WHERE event.received_at >= ${recentCutoff.toISOString()}
          AND host.revoked_at IS NULL
        ORDER BY event.received_at DESC
        LIMIT 200
      `,
      this.#sql`
        SELECT id, status, claimed_label, expires_at, created_at
        FROM pairing_sessions
        WHERE expires_at > ${now.toISOString()}
          AND status IN ('created', 'claimed', 'approved')
        ORDER BY created_at DESC
      `,
      this.#sql`
        SELECT id, created_at, last_success_at, disabled_at
        FROM push_subscriptions
        ORDER BY created_at DESC
      `,
    ]);

    return {
      hosts: hostRows.map((row) => ({
        id: String(row.id),
        label: String(row.label),
        createdAt: iso(row.created_at),
        approvedAt: iso(row.approved_at),
        lastSeenAt: nullableIso(row.last_seen_at),
        revokedAt: nullableIso(row.revoked_at),
        bridgeVersion: row.bridge_version == null ? null : String(row.bridge_version),
        queuedEventCount: integer(row.queued_event_count),
        sourceHealth: jsonArray(row.source_health),
      })),
      tasks: taskRows.map((row) => ({
        id: String(row.id),
        hostId: String(row.host_id),
        hostLabel: String(row.host_label),
        alias: row.alias == null ? null : String(row.alias),
        state: String(row.state) as DashboardView["tasks"][number]["state"],
        attentionReason:
          row.attention_reason == null
            ? null
            : (String(row.attention_reason) as DashboardView["tasks"][number]["attentionReason"]),
        source: String(row.source) as DashboardView["tasks"][number]["source"],
        sourcePrecision: String(
          row.source_precision,
        ) as DashboardView["tasks"][number]["sourcePrecision"],
        sourceUpdatedAt: iso(row.source_updated_at),
        observedAt: iso(row.observed_at),
        relayReceivedAt: iso(row.relay_received_at),
        unread: Boolean(row.unread),
        muted: Boolean(row.muted),
        notifyOn: jsonArray<EventType>(row.notify_on),
      })),
      events: eventRows.map((row) => ({
        id: String(row.event_id),
        taskId: String(row.task_id),
        hostId: String(row.host_id),
        hostLabel: String(row.host_label),
        taskAlias: row.task_alias == null ? null : String(row.task_alias),
        type: String(row.type) as DashboardView["events"][number]["type"],
        reason:
          row.reason == null
            ? null
            : (String(row.reason) as DashboardView["events"][number]["reason"]),
        occurredAt: iso(row.occurred_at),
        observedAt: iso(row.observed_at),
        receivedAt: iso(row.received_at),
        source: String(row.source) as DashboardView["events"][number]["source"],
        sourcePrecision: String(
          row.source_precision,
        ) as DashboardView["events"][number]["sourcePrecision"],
        unread: Boolean(row.unread),
        pushAttemptedAt: nullableIso(row.push_attempted_at),
        pushAcceptedAt: nullableIso(row.push_accepted_at),
        openedAt: nullableIso(row.opened_at),
        pushAttemptCount: integer(row.push_attempt_count),
        pushErrorCategory: row.push_error_category == null ? null : String(row.push_error_category),
      })),
      pairings: pairingRows.map((row) => ({
        id: String(row.id),
        status: String(row.status) as PairingView["status"],
        claimedLabel: row.claimed_label == null ? null : String(row.claimed_label),
        expiresAt: iso(row.expires_at),
        createdAt: iso(row.created_at),
      })),
      subscriptions: subscriptionRows.map((row) => ({
        id: String(row.id),
        createdAt: iso(row.created_at),
        lastSuccessAt: nullableIso(row.last_success_at),
        disabledAt: nullableIso(row.disabled_at),
      })),
      limits,
      serverTime: now.toISOString(),
    };
  }

  async getHostSecret(hostId: string): Promise<HostSecretRecord | null> {
    const rows = await this.#sql`
      SELECT id, label, secret_ciphertext, approved_at, revoked_at
      FROM hosts WHERE id = ${hostId} LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      id: String(row.id),
      label: String(row.label),
      secretCiphertext: String(row.secret_ciphertext),
      approvedAt: nullableIso(row.approved_at),
      revokedAt: nullableIso(row.revoked_at),
    };
  }

  async registerHostNonce(hostId: string, nonce: string, now: Date): Promise<boolean> {
    const rows = await this.#sql`
      INSERT INTO host_nonces (host_id, nonce, seen_at)
      VALUES (${hostId}, ${nonce}, ${now.toISOString()})
      ON CONFLICT DO NOTHING
      RETURNING nonce
    `;
    return rows.length === 1;
  }

  async updateHeartbeat(hostId: string, heartbeat: unknown, now: Date): Promise<void> {
    const value = heartbeat as {
      bridgeVersion: string;
      queuedEventCount: number;
      sources: unknown[];
    };
    await this.#sql`
      UPDATE hosts
      SET last_seen_at = ${now.toISOString()},
          bridge_version = ${value.bridgeVersion},
          queued_event_count = ${value.queuedEventCount},
          source_health = ${JSON.stringify(value.sources)}::jsonb
      WHERE id = ${hostId} AND approved_at IS NOT NULL AND revoked_at IS NULL
    `;
  }

  async ingest(
    hostId: string,
    body: IngestRequest,
    now: Date,
    maxTasks: number,
    maxEvents: number,
  ): Promise<IngestResult> {
    const eventCapacityRows = await this.#sql`
      SELECT
        EXISTS (SELECT 1 FROM events WHERE event_id = ${body.event.eventId}) AS event_exists,
        (SELECT count(*)::integer FROM events) AS event_count
    `;
    const eventCapacity = eventCapacityRows[0];
    if (
      eventCapacity?.event_exists !== true &&
      integer(eventCapacity?.event_count ?? 0) >= maxEvents
    ) {
      throw new Error("FREE_TIER_EVENT_LIMIT");
    }

    const existingRows = await this.#sql`
      SELECT id FROM tasks WHERE host_id = ${hostId} AND task_key = ${body.snapshot.taskKey}
    `;
    if (existingRows.length === 0) {
      const countRows = await this.#sql`SELECT count(*)::integer AS count FROM tasks`;
      if (integer(countRows[0]?.count ?? 0) >= maxTasks) {
        throw new Error("FREE_TIER_TASK_LIMIT");
      }
    }

    const taskId = existingRows[0]?.id ? String(existingRows[0].id) : randomUUID();
    const snapshot = body.snapshot;
    const taskRows = await this.#sql`
      INSERT INTO tasks (
        id, host_id, task_key, state, attention_reason, source, source_precision,
        source_updated_at, observed_at, relay_received_at, expires_at, revision
      ) VALUES (
        ${taskId}, ${hostId}, ${snapshot.taskKey}, ${snapshot.state},
        ${snapshot.attentionReason}, ${snapshot.source}, ${snapshot.sourcePrecision},
        ${snapshot.sourceUpdatedAt}, ${snapshot.observedAt}, ${now.toISOString()},
        ${snapshot.expiresAt}, ${snapshot.revision}
      )
      ON CONFLICT (host_id, task_key) DO UPDATE SET
        state = EXCLUDED.state,
        attention_reason = EXCLUDED.attention_reason,
        source = EXCLUDED.source,
        source_precision = EXCLUDED.source_precision,
        source_updated_at = EXCLUDED.source_updated_at,
        observed_at = EXCLUDED.observed_at,
        relay_received_at = EXCLUDED.relay_received_at,
        expires_at = EXCLUDED.expires_at,
        revision = EXCLUDED.revision,
        unread = true
      WHERE tasks.revision < EXCLUDED.revision
      RETURNING id, alias, muted, notify_on
    `;

    let taskRow = taskRows[0];
    if (!taskRow) {
      const rows = await this.#sql`
        SELECT id, alias, muted, notify_on
        FROM tasks WHERE host_id = ${hostId} AND task_key = ${snapshot.taskKey}
      `;
      taskRow = rows[0];
    }
    if (!taskRow) throw new Error("TASK_PROJECTION_FAILED");

    const event = body.event;
    const expiresAt = new Date(Date.parse(event.occurredAt) + event.ttlSeconds * 1000);
    const eventRows = await this.#sql`
      INSERT INTO events (
        event_id, task_id, host_id, type, reason, occurred_at, observed_at,
        received_at, source, source_precision, sequence, expires_at
      ) VALUES (
        ${event.eventId}, ${String(taskRow.id)}, ${hostId}, ${event.type}, ${event.reason},
        ${event.occurredAt}, ${event.observedAt}, ${now.toISOString()}, ${event.source},
        ${event.sourcePrecision}, ${event.sequence}, ${expiresAt.toISOString()}
      )
      ON CONFLICT (event_id) DO NOTHING
      RETURNING event_id
    `;
    const duplicate = eventRows.length === 0;
    let retryTransientPush = false;
    if (duplicate) {
      const deliveryRows = await this.#sql`
        SELECT push_accepted_at, push_error_category, push_attempt_count
        FROM events WHERE event_id = ${event.eventId}
      `;
      const delivery = deliveryRows[0];
      retryTransientPush = shouldRetryTransientPush({
        acceptedAt: nullableIso(delivery?.push_accepted_at),
        errorCategory: delivery?.push_error_category == null ? null : String(delivery.push_error_category),
        attemptCount: integer(delivery?.push_attempt_count ?? 0),
      });
    }

    await this.#sql`
      UPDATE hosts
      SET last_seen_at = ${now.toISOString()},
          last_sequence = GREATEST(last_sequence, ${event.sequence})
      WHERE id = ${hostId}
    `;

    const preferences: TaskPreferences = {
      alias: taskRow.alias == null ? null : String(taskRow.alias),
      muted: Boolean(taskRow.muted),
      notifyOn: jsonArray<EventType>(taskRow.notify_on),
    };
    const hostRows = await this.#sql`SELECT label FROM hosts WHERE id = ${hostId}`;
    const hostLabel = String(hostRows[0]?.label ?? "Mac");

    return {
      accepted: true,
      duplicate,
      taskId: String(taskRow.id),
      shouldNotify:
        (!duplicate || retryTransientPush) &&
        !isExpired(event.occurredAt, event.ttlSeconds, now) &&
        shouldNotify(preferences, event.type),
      hostLabel,
      taskAlias: preferences.alias,
      event,
    };
  }

  async upsertSnapshots(
    hostId: string,
    body: SnapshotBatch,
    now: Date,
    maxTasks: number,
  ): Promise<number> {
    if (body.snapshots.length === 0) return 0;

    const keys = JSON.stringify(body.snapshots.map((snapshot) => snapshot.taskKey));
    const capacityRows = await this.#sql`
      WITH incoming AS (
        SELECT DISTINCT value AS task_key
        FROM jsonb_array_elements_text(${keys}::jsonb)
      )
      SELECT
        (SELECT count(*)::integer FROM tasks) AS task_count,
        count(*) FILTER (WHERE task.id IS NULL)::integer AS new_count
      FROM incoming
      LEFT JOIN tasks AS task
        ON task.host_id = ${hostId} AND task.task_key = incoming.task_key
    `;
    const capacity = capacityRows[0];
    if (
      integer(capacity?.task_count ?? 0) + integer(capacity?.new_count ?? 0) > maxTasks
    ) {
      throw new Error("FREE_TIER_TASK_LIMIT");
    }

    const payload = JSON.stringify(body.snapshots.map((snapshot) => ({
      id: randomUUID(),
      ...snapshot,
    })));
    const rows = await this.#sql`
      WITH incoming AS (
        SELECT *
        FROM jsonb_to_recordset(${payload}::jsonb) AS value(
          id uuid,
          "taskKey" varchar(128),
          state varchar(24),
          "attentionReason" varchar(24),
          source varchar(24),
          "sourcePrecision" varchar(24),
          "sourceUpdatedAt" timestamptz,
          "observedAt" timestamptz,
          "expiresAt" timestamptz,
          revision bigint,
          "schemaVersion" integer
        )
      )
      INSERT INTO tasks (
        id, host_id, task_key, state, attention_reason, source, source_precision,
        source_updated_at, observed_at, relay_received_at, expires_at, revision
      )
      SELECT
        id, ${hostId}, "taskKey", state, "attentionReason", source,
        "sourcePrecision", "sourceUpdatedAt", "observedAt", ${now.toISOString()},
        "expiresAt", revision
      FROM incoming
      ON CONFLICT (host_id, task_key) DO UPDATE SET
        state = EXCLUDED.state,
        attention_reason = EXCLUDED.attention_reason,
        source = EXCLUDED.source,
        source_precision = EXCLUDED.source_precision,
        source_updated_at = EXCLUDED.source_updated_at,
        observed_at = EXCLUDED.observed_at,
        relay_received_at = EXCLUDED.relay_received_at,
        expires_at = EXCLUDED.expires_at,
        revision = EXCLUDED.revision
      WHERE tasks.revision < EXCLUDED.revision
      RETURNING id
    `;
    return rows.length;
  }

  async revokeHost(hostId: string, now: Date): Promise<boolean> {
    const rows = await this.#sql`
      UPDATE hosts SET revoked_at = ${now.toISOString()}
      WHERE id = ${hostId} AND revoked_at IS NULL
      RETURNING id
    `;
    if (rows.length) await this.audit("host_revoked", hostId, now);
    return rows.length === 1;
  }

  async registerPushSubscription(input: {
    id: string;
    endpointHash: string;
    payloadCiphertext: string;
    now: Date;
    maxSubscriptions: number;
  }): Promise<{ id: string; created: boolean }> {
    const existing = await this.#sql`
      SELECT id FROM push_subscriptions WHERE endpoint_hash = ${input.endpointHash}
    `;
    if (existing.length === 0) {
      const countRows = await this.#sql`
        SELECT count(*)::integer AS count
        FROM push_subscriptions WHERE disabled_at IS NULL
      `;
      if (integer(countRows[0]?.count ?? 0) >= input.maxSubscriptions) {
        throw new Error("FREE_TIER_SUBSCRIPTION_LIMIT");
      }
    }

    const rows = await this.#sql`
      INSERT INTO push_subscriptions (
        id, endpoint_hash, payload_ciphertext, created_at, updated_at
      ) VALUES (
        ${input.id}, ${input.endpointHash}, ${input.payloadCiphertext},
        ${input.now.toISOString()}, ${input.now.toISOString()}
      )
      ON CONFLICT (endpoint_hash) DO UPDATE SET
        payload_ciphertext = EXCLUDED.payload_ciphertext,
        updated_at = EXCLUDED.updated_at,
        disabled_at = NULL,
        error_category = NULL
      RETURNING id, (xmax = 0) AS created
    `;
    const row = rows[0];
    if (!row) throw new Error("SUBSCRIPTION_UPSERT_FAILED");
    return { id: String(row.id), created: Boolean(row.created) };
  }

  async removePushSubscription(endpointHash: string, now: Date): Promise<boolean> {
    const rows = await this.#sql`
      DELETE FROM push_subscriptions
      WHERE endpoint_hash = ${endpointHash}
      RETURNING id
    `;
    void now;
    return rows.length > 0;
  }

  async removePushSubscriptionById(id: string, now: Date): Promise<boolean> {
    const rows = await this.#sql`
      DELETE FROM push_subscriptions
      WHERE id = ${id}
      RETURNING id
    `;
    void now;
    return rows.length > 0;
  }

  async activePushSubscriptions(): Promise<PushRecord[]> {
    const rows = await this.#sql`
      SELECT id, payload_ciphertext
      FROM push_subscriptions WHERE disabled_at IS NULL
    `;
    return rows.map((row) => ({
      id: String(row.id),
      payloadCiphertext: String(row.payload_ciphertext),
    }));
  }

  async markPushSuccess(id: string, now: Date): Promise<void> {
    await this.#sql`
      UPDATE push_subscriptions
      SET last_success_at = ${now.toISOString()}, updated_at = ${now.toISOString()},
          error_category = NULL
      WHERE id = ${id}
    `;
  }

  async disablePushSubscription(id: string, now: Date, errorCategory: string): Promise<void> {
    await this.#sql`
      UPDATE push_subscriptions
      SET disabled_at = ${now.toISOString()}, updated_at = ${now.toISOString()},
          error_category = ${errorCategory}
      WHERE id = ${id}
    `;
  }

  async recordEventPushResult(input: {
    eventId: string;
    attemptedAt: Date;
    completedAt: Date;
    attempted: number;
    delivered: number;
    errorCategory: string | null;
  }): Promise<void> {
    await this.#sql`
      UPDATE events
      SET push_attempted_at = ${input.attemptedAt.toISOString()},
          push_accepted_at = CASE
            WHEN ${input.delivered} > 0 THEN ${input.completedAt.toISOString()}::timestamptz
            ELSE push_accepted_at
          END,
          push_attempt_count = push_attempt_count + 1,
          push_error_category = ${input.errorCategory}
      WHERE event_id = ${input.eventId}
    `;
  }

  async updateTaskPreferences(input: {
    taskId: string;
    alias: string | null;
    muted: boolean;
    notifyOn: EventType[];
    now: Date;
  }): Promise<boolean> {
    const rows = await this.#sql`
      UPDATE tasks
      SET alias = ${input.alias}, muted = ${input.muted},
          notify_on = ${JSON.stringify(input.notifyOn)}::jsonb
      WHERE id = ${input.taskId}
      RETURNING id
    `;
    return rows.length === 1;
  }

  async markEventRead(eventId: string, now: Date, fromNotification: boolean): Promise<boolean> {
    const rows = await this.#sql`
      UPDATE events
      SET unread = false,
          opened_at = CASE
            WHEN ${fromNotification} THEN COALESCE(opened_at, ${now.toISOString()}::timestamptz)
            ELSE opened_at
          END
      WHERE event_id = ${eventId}
      RETURNING task_id
    `;
    const taskId = rows[0]?.task_id;
    if (!taskId) return false;
    await this.#sql`
      UPDATE events SET unread = false WHERE task_id = ${String(taskId)}
    `;
    await this.#sql`
      UPDATE tasks SET unread = false WHERE id = ${String(taskId)}
    `;
    return true;
  }

  async cleanup(now: Date, limits: RelayConfig["limits"]): Promise<{
    eventsDeleted: number;
    noncesDeleted: number;
    attemptsDeleted: number;
    pairingsDeleted: number;
    subscriptionsDeleted: number;
  }> {
    const retentionCutoff = new Date(now.getTime() - limits.retentionDays * 86_400_000);
    const nonceCutoff = new Date(now.getTime() - 10 * 60 * 1000);
    const attemptCutoff = new Date(now.getTime() - 60 * 60 * 1000);
    const disabledSubscriptionCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const [expiredEvents, overflowEvents, nonces, attempts, pairings, subscriptions] =
      await Promise.all([
        this.#sql`
          DELETE FROM events
          WHERE expires_at < ${now.toISOString()} OR received_at < ${retentionCutoff.toISOString()}
          RETURNING event_id
        `,
        this.#sql`
          DELETE FROM events
          WHERE event_id IN (
            SELECT event_id FROM events
            ORDER BY received_at DESC
            OFFSET ${Math.max(limits.events, 0)}
          )
          RETURNING event_id
        `,
        this.#sql`
          DELETE FROM host_nonces WHERE seen_at < ${nonceCutoff.toISOString()} RETURNING nonce
        `,
        this.#sql`
          DELETE FROM rate_limit_attempts
          WHERE attempted_at < ${attemptCutoff.toISOString()} RETURNING id
        `,
        this.#sql`
          DELETE FROM pairing_sessions
          WHERE expires_at < ${now.toISOString()} AND status != 'approved'
          RETURNING id
        `,
        this.#sql`
          DELETE FROM push_subscriptions
          WHERE disabled_at IS NOT NULL
            AND disabled_at < ${disabledSubscriptionCutoff.toISOString()}
          RETURNING id
        `,
      ]);
    await this.#sql`
      DELETE FROM tasks
      WHERE observed_at < ${retentionCutoff.toISOString()}
        AND state NOT IN ('running', 'needs_attention')
    `;
    await this.#sql`
      DELETE FROM hosts
      WHERE approved_at IS NULL
        AND created_at < ${new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()}
    `;
    return {
      eventsDeleted: expiredEvents.length + overflowEvents.length,
      noncesDeleted: nonces.length,
      attemptsDeleted: attempts.length,
      pairingsDeleted: pairings.length,
      subscriptionsDeleted: subscriptions.length,
    };
  }

  private async audit(category: string, subjectId: string, now: Date): Promise<void> {
    await this.#sql`
      INSERT INTO audit_events (category, subject_id, occurred_at)
      VALUES (${category}, ${subjectId}, ${now.toISOString()})
    `;
  }
}
