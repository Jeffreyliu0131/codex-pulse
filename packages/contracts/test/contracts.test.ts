import assert from "node:assert/strict";
import test from "node:test";
import {
  IngestRequestSchema,
  PushSubscriptionRegistrationSchema,
  SCHEMA_VERSION,
  SnapshotBatchSchema,
} from "../src/index.ts";

const timestamp = "2026-08-11T08:00:00.000Z";
const taskKey = `tsk_${"a".repeat(32)}`;
const eventId = `evt_${"b".repeat(32)}`;

test("accepts a content-minimal normalized event", () => {
  const parsed = IngestRequestSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    event: {
      schemaVersion: SCHEMA_VERSION,
      eventId,
      taskKey,
      type: "attention_required",
      reason: "approval",
      occurredAt: timestamp,
      observedAt: timestamp,
      source: "app_server",
      sourcePrecision: "live_status",
      sequence: 7,
      ttlSeconds: 900,
    },
    snapshot: {
      schemaVersion: SCHEMA_VERSION,
      taskKey,
      state: "needs_attention",
      attentionReason: "approval",
      source: "app_server",
      sourcePrecision: "live_status",
      sourceUpdatedAt: timestamp,
      observedAt: timestamp,
      expiresAt: null,
      revision: 7,
    },
  });

  assert.equal(parsed.event.reason, "approval");
  assert.equal("prompt" in parsed.event, false);
  assert.equal("path" in parsed.snapshot, false);
});

test("rejects raw identifiers and unversioned events", () => {
  const result = IngestRequestSchema.safeParse({
    schemaVersion: SCHEMA_VERSION,
    event: { eventId: "thread-123", taskKey: "thread-123" },
    snapshot: {},
  });
  assert.equal(result.success, false);
});

test("rejects forbidden content even when the normalized fields are valid", () => {
  const result = IngestRequestSchema.safeParse({
    schemaVersion: SCHEMA_VERSION,
    event: {
      schemaVersion: SCHEMA_VERSION,
      eventId,
      taskKey,
      type: "task_completed",
      reason: null,
      occurredAt: timestamp,
      observedAt: timestamp,
      source: "notify",
      sourcePrecision: "event",
      sequence: 8,
      ttlSeconds: 900,
      lastAssistantMessage: "private content",
    },
    snapshot: {
      schemaVersion: SCHEMA_VERSION,
      taskKey,
      state: "completed",
      attentionReason: null,
      source: "notify",
      sourcePrecision: "event",
      sourceUpdatedAt: timestamp,
      observedAt: timestamp,
      expiresAt: null,
      revision: 8,
    },
  });
  assert.equal(result.success, false);
});

test("validates a browser push subscription", () => {
  const result = PushSubscriptionRegistrationSchema.safeParse({
    endpoint: "https://push.example.test/subscription/opaque",
    expirationTime: null,
    keys: {
      p256dh: "p".repeat(64),
      auth: "a".repeat(24),
    },
  });
  assert.equal(result.success, true);
});

test("rejects contradictory event and snapshot state", () => {
  const result = IngestRequestSchema.safeParse({
    schemaVersion: SCHEMA_VERSION,
    event: {
      schemaVersion: SCHEMA_VERSION,
      eventId,
      taskKey,
      type: "task_completed",
      reason: null,
      occurredAt: timestamp,
      observedAt: timestamp,
      source: "notify",
      sourcePrecision: "event",
      sequence: 9,
      ttlSeconds: 900,
    },
    snapshot: {
      schemaVersion: SCHEMA_VERSION,
      taskKey,
      state: "running",
      attentionReason: null,
      source: "notify",
      sourcePrecision: "event",
      sourceUpdatedAt: timestamp,
      observedAt: timestamp,
      expiresAt: null,
      revision: 9,
    },
  });
  assert.equal(result.success, false);
});

test("rejects an event reason that disagrees with its snapshot", () => {
  const result = IngestRequestSchema.safeParse({
    schemaVersion: SCHEMA_VERSION,
    event: {
      schemaVersion: SCHEMA_VERSION,
      eventId,
      taskKey,
      type: "attention_required",
      reason: "approval",
      occurredAt: timestamp,
      observedAt: timestamp,
      source: "app_server",
      sourcePrecision: "live_status",
      sequence: 10,
      ttlSeconds: 900,
    },
    snapshot: {
      schemaVersion: SCHEMA_VERSION,
      taskKey,
      state: "needs_attention",
      attentionReason: "user_input",
      source: "app_server",
      sourcePrecision: "live_status",
      sourceUpdatedAt: timestamp,
      observedAt: timestamp,
      expiresAt: null,
      revision: 10,
    },
  });
  assert.equal(result.success, false);
});

test("validates unique content-minimal snapshot repair batches", () => {
  const snapshot = {
    schemaVersion: SCHEMA_VERSION,
    taskKey,
    state: "running" as const,
    attentionReason: null,
    source: "app_server" as const,
    sourcePrecision: "polled_status" as const,
    sourceUpdatedAt: timestamp,
    observedAt: timestamp,
    expiresAt: null,
    revision: 10,
  };
  assert.equal(SnapshotBatchSchema.safeParse({ schemaVersion: 1, snapshots: [snapshot] }).success, true);
  assert.equal(SnapshotBatchSchema.safeParse({ schemaVersion: 1, snapshots: [snapshot, snapshot] }).success, false);
});
