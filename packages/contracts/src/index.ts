import { z } from "zod";

export const SCHEMA_VERSION = 1 as const;

export const TaskStateSchema = z.enum([
  "running",
  "needs_attention",
  "failed",
  "completed",
  "inactive",
  "unknown",
]);

export const AttentionReasonSchema = z.enum([
  "approval",
  "user_input",
  "system_error",
]);

export const EventTypeSchema = z.enum([
  "task_started",
  "attention_required",
  "attention_cleared",
  "task_completed",
  "task_failed",
  "task_updated",
  "source_stale",
]);

export const EventSourceSchema = z.enum([
  "notify",
  "app_server",
  "rollout",
  "state_db",
  "desktop_ipc",
  "remote_cache",
  "synthetic",
]);

export const SourcePrecisionSchema = z.enum([
  "event",
  "live_status",
  "polled_status",
  "cached_summary",
]);

const TimestampSchema = z.string().datetime({ offset: true });
const OpaqueTaskKeySchema = z.string().regex(/^tsk_[A-Za-z0-9_-]{24,96}$/);
const OpaqueEventIdSchema = z.string().regex(/^evt_[A-Za-z0-9_-]{24,96}$/);

export const TaskSnapshotSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  taskKey: OpaqueTaskKeySchema,
  state: TaskStateSchema,
  attentionReason: AttentionReasonSchema.nullable(),
  source: EventSourceSchema,
  sourcePrecision: SourcePrecisionSchema,
  sourceUpdatedAt: TimestampSchema,
  observedAt: TimestampSchema,
  expiresAt: TimestampSchema.nullable(),
  revision: z.number().int().nonnegative(),
}).strict().superRefine((snapshot, context) => {
  if (
    snapshot.state === "needs_attention" &&
    snapshot.attentionReason !== "approval" &&
    snapshot.attentionReason !== "user_input"
  ) {
    context.addIssue({
      code: "custom",
      path: ["attentionReason"],
      message: "needs_attention requires approval or user_input",
    });
  }
  if (
    snapshot.state !== "needs_attention" &&
    snapshot.state !== "failed" &&
    snapshot.attentionReason !== null
  ) {
    context.addIssue({
      code: "custom",
      path: ["attentionReason"],
      message: "attentionReason is only valid for attention or failure states",
    });
  }
  if (snapshot.state === "failed" && snapshot.attentionReason != null && snapshot.attentionReason !== "system_error") {
    context.addIssue({
      code: "custom",
      path: ["attentionReason"],
      message: "failed snapshots may only use system_error",
    });
  }
});

export const TaskEventSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  eventId: OpaqueEventIdSchema,
  taskKey: OpaqueTaskKeySchema,
  type: EventTypeSchema,
  reason: AttentionReasonSchema.nullable(),
  occurredAt: TimestampSchema,
  observedAt: TimestampSchema,
  source: EventSourceSchema,
  sourcePrecision: SourcePrecisionSchema,
  sequence: z.number().int().positive(),
  ttlSeconds: z.number().int().min(60).max(7 * 24 * 60 * 60),
}).strict().superRefine((event, context) => {
  if (
    event.type === "attention_required" &&
    event.reason !== "approval" &&
    event.reason !== "user_input"
  ) {
    context.addIssue({
      code: "custom",
      path: ["reason"],
      message: "attention_required requires approval or user_input",
    });
  }
  if (event.type === "task_failed" && event.reason != null && event.reason !== "system_error") {
    context.addIssue({
      code: "custom",
      path: ["reason"],
      message: "task_failed may only use system_error",
    });
  }
  if (event.type !== "attention_required" && event.type !== "task_failed" && event.reason !== null) {
    context.addIssue({
      code: "custom",
      path: ["reason"],
      message: "this event type must not carry an attention reason",
    });
  }
});

export const IngestRequestSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  event: TaskEventSchema,
  snapshot: TaskSnapshotSchema,
}).strict().superRefine((request, context) => {
  const { event, snapshot } = request;
  const mismatches: Array<[boolean, string, Array<string | number>]> = [
    [event.taskKey !== snapshot.taskKey, "event and snapshot task keys must match", ["snapshot", "taskKey"]],
    [event.sequence !== snapshot.revision, "event sequence and snapshot revision must match", ["snapshot", "revision"]],
    [event.source !== snapshot.source, "event and snapshot sources must match", ["snapshot", "source"]],
    [event.sourcePrecision !== snapshot.sourcePrecision, "event and snapshot precision must match", ["snapshot", "sourcePrecision"]],
    [event.observedAt !== snapshot.observedAt, "event and snapshot observation times must match", ["snapshot", "observedAt"]],
    [event.reason !== snapshot.attentionReason, "event reason and snapshot attention reason must match", ["snapshot", "attentionReason"]],
  ];
  for (const [invalid, message, path] of mismatches) {
    if (invalid) context.addIssue({ code: "custom", message, path });
  }

  const expectedStates: Partial<Record<z.infer<typeof EventTypeSchema>, z.infer<typeof TaskStateSchema>>> = {
    task_started: "running",
    attention_required: "needs_attention",
    task_completed: "completed",
    task_failed: "failed",
    source_stale: "unknown",
  };
  const expectedState = expectedStates[event.type];
  if (expectedState && snapshot.state !== expectedState) {
    context.addIssue({
      code: "custom",
      path: ["snapshot", "state"],
      message: `${event.type} requires a ${expectedState} snapshot`,
    });
  }
  if (event.type === "attention_cleared" && snapshot.state === "needs_attention") {
    context.addIssue({
      code: "custom",
      path: ["snapshot", "state"],
      message: "attention_cleared cannot retain needs_attention",
    });
  }
});

export const SnapshotBatchSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  snapshots: z.array(TaskSnapshotSchema).max(100),
}).strict().superRefine((batch, context) => {
  const keys = new Set<string>();
  for (const [index, snapshot] of batch.snapshots.entries()) {
    if (keys.has(snapshot.taskKey)) {
      context.addIssue({
        code: "custom",
        path: ["snapshots", index, "taskKey"],
        message: "snapshot batch contains a duplicate task key",
      });
    }
    keys.add(snapshot.taskKey);
  }
});

export const HostHeartbeatSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  observedAt: TimestampSchema,
  bridgeVersion: z.string().min(1).max(32),
  sources: z.array(
    z.object({
      source: EventSourceSchema,
      healthy: z.boolean(),
      lastSuccessAt: TimestampSchema.nullable(),
      errorCategory: z.string().max(64).nullable(),
    }).strict(),
  ).max(8),
  queuedEventCount: z.number().int().nonnegative().max(1000),
}).strict();

export const PushSubscriptionRegistrationSchema = z.object({
  endpoint: z.string().url().max(2048),
  expirationTime: z.number().nullable(),
  keys: z.object({
    p256dh: z.string().min(32).max(256),
    auth: z.string().min(8).max(128),
  }).strict(),
}).strict();

export const TaskPreferencesSchema = z.object({
  alias: z.string().trim().max(64).nullable(),
  muted: z.boolean(),
  notifyOn: z.array(EventTypeSchema).max(EventTypeSchema.options.length),
}).strict();

export const SafePushPayloadSchema = z.object({
  web_push: z.literal(8030),
  notification: z.object({
    title: z.string().max(64),
    body: z.string().max(128),
    navigate: z.string().url(),
    lang: z.literal("zh-CN"),
    dir: z.literal("ltr"),
    silent: z.literal(false),
    app_badge: z.string().regex(/^\d{1,4}$/),
    data: z.object({
      schemaVersion: z.literal(SCHEMA_VERSION),
      taskId: z.string().uuid().nullable(),
      eventId: z.string().max(128),
      type: z.union([EventTypeSchema, z.literal("test")]),
      url: z.string().startsWith("/"),
    }).strict(),
  }).strict(),
}).strict();

export type TaskState = z.infer<typeof TaskStateSchema>;
export type AttentionReason = z.infer<typeof AttentionReasonSchema>;
export type EventType = z.infer<typeof EventTypeSchema>;
export type EventSource = z.infer<typeof EventSourceSchema>;
export type SourcePrecision = z.infer<typeof SourcePrecisionSchema>;
export type TaskSnapshot = z.infer<typeof TaskSnapshotSchema>;
export type TaskEvent = z.infer<typeof TaskEventSchema>;
export type IngestRequest = z.infer<typeof IngestRequestSchema>;
export type SnapshotBatch = z.infer<typeof SnapshotBatchSchema>;
export type HostHeartbeat = z.infer<typeof HostHeartbeatSchema>;
export type PushSubscriptionRegistration = z.infer<
  typeof PushSubscriptionRegistrationSchema
>;
export type TaskPreferences = z.infer<typeof TaskPreferencesSchema>;
export type SafePushPayload = z.infer<typeof SafePushPayloadSchema>;
