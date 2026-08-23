import type {
  AttentionReason,
  EventSource,
  EventType,
  IngestRequest,
  SnapshotBatch,
  SourcePrecision,
  TaskState,
} from "@codexpulse/contracts";

export interface RelayConfig {
  appOrigin: string;
  accessToken: string;
  sessionSecret: string;
  masterKey: Buffer;
  vapidPublicKey: string;
  vapidPrivateKey: string;
  vapidSubject: string;
  cronSecret: string | null;
  databaseUrl: string;
  nodeEnv: "development" | "test" | "production";
  limits: {
    hosts: number;
    subscriptions: number;
    tasks: number;
    events: number;
    retentionDays: number;
  };
}

export interface HostSecretRecord {
  id: string;
  label: string;
  secretCiphertext: string;
  approvedAt: string | null;
  revokedAt: string | null;
}

export interface PairingView {
  id: string;
  status: "created" | "claimed" | "approved" | "rejected" | "consumed";
  claimedLabel: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface HostView {
  id: string;
  label: string;
  createdAt: string;
  approvedAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  bridgeVersion: string | null;
  queuedEventCount: number;
  sourceHealth: unknown[];
}

export interface TaskView {
  id: string;
  hostId: string;
  hostLabel: string;
  alias: string | null;
  state: TaskState;
  attentionReason: AttentionReason | null;
  source: EventSource;
  sourcePrecision: SourcePrecision;
  sourceUpdatedAt: string;
  observedAt: string;
  relayReceivedAt: string;
  unread: boolean;
  muted: boolean;
  notifyOn: EventType[];
}

export interface EventView {
  id: string;
  taskId: string;
  hostId: string;
  hostLabel: string;
  taskAlias: string | null;
  type: EventType;
  reason: AttentionReason | null;
  occurredAt: string;
  observedAt: string;
  receivedAt: string;
  source: EventSource;
  sourcePrecision: SourcePrecision;
  unread: boolean;
  pushAttemptedAt: string | null;
  pushAcceptedAt: string | null;
  openedAt: string | null;
  pushAttemptCount: number;
  pushErrorCategory: string | null;
}

export interface SubscriptionView {
  id: string;
  createdAt: string;
  lastSuccessAt: string | null;
  disabledAt: string | null;
}

export interface DashboardView {
  hosts: HostView[];
  tasks: TaskView[];
  events: EventView[];
  pairings: PairingView[];
  subscriptions: SubscriptionView[];
  limits: RelayConfig["limits"];
  serverTime: string;
}

export interface IngestResult {
  accepted: boolean;
  duplicate: boolean;
  taskId: string;
  shouldNotify: boolean;
  hostLabel: string;
  taskAlias: string | null;
  event: IngestRequest["event"];
}

export interface PushRecord {
  id: string;
  payloadCiphertext: string;
}

export interface RelayStore {
  ping(): Promise<void>;
  recordRateLimitAttempt(scope: string, fingerprint: string, now: Date): Promise<number>;
  createPairing(input: {
    id: string;
    codeHash: string;
    expiresAt: Date;
    now: Date;
  }): Promise<void>;
  claimPairing(input: {
    codeHash: string;
    hostId: string;
    hostLabel: string;
    secretCiphertext: string;
    claimTokenHash: string;
    now: Date;
  }): Promise<{ id: string; expiresAt: string } | null>;
  getPairingClaim(claimTokenHash: string, now: Date): Promise<{
    pairingId: string;
    status: PairingView["status"];
    hostId: string;
    hostLabel: string;
    secretCiphertext: string;
    expiresAt: string;
    credentialDeliveredAt: string | null;
  } | null>;
  markCredentialDelivered(pairingId: string, now: Date): Promise<void>;
  approvePairing(pairingId: string, now: Date, maxHosts: number): Promise<boolean>;
  rejectPairing(pairingId: string, now: Date): Promise<boolean>;
  dashboard(now: Date, limits: RelayConfig["limits"]): Promise<DashboardView>;
  getHostSecret(hostId: string): Promise<HostSecretRecord | null>;
  registerHostNonce(hostId: string, nonce: string, now: Date): Promise<boolean>;
  updateHeartbeat(hostId: string, heartbeat: unknown, now: Date): Promise<void>;
  ingest(
    hostId: string,
    body: IngestRequest,
    now: Date,
    maxTasks: number,
    maxEvents: number,
  ): Promise<IngestResult>;
  upsertSnapshots(
    hostId: string,
    body: SnapshotBatch,
    now: Date,
    maxTasks: number,
  ): Promise<number>;
  revokeHost(hostId: string, now: Date): Promise<boolean>;
  registerPushSubscription(input: {
    id: string;
    endpointHash: string;
    payloadCiphertext: string;
    now: Date;
    maxSubscriptions: number;
  }): Promise<{ id: string; created: boolean }>;
  removePushSubscription(endpointHash: string, now: Date): Promise<boolean>;
  removePushSubscriptionById(id: string, now: Date): Promise<boolean>;
  activePushSubscriptions(): Promise<PushRecord[]>;
  markPushSuccess(id: string, now: Date): Promise<void>;
  disablePushSubscription(id: string, now: Date, errorCategory: string): Promise<void>;
  recordEventPushResult(input: {
    eventId: string;
    attemptedAt: Date;
    completedAt: Date;
    attempted: number;
    delivered: number;
    errorCategory: string | null;
  }): Promise<void>;
  updateTaskPreferences(input: {
    taskId: string;
    alias: string | null;
    muted: boolean;
    notifyOn: EventType[];
    now: Date;
  }): Promise<boolean>;
  markEventRead(eventId: string, now: Date, fromNotification: boolean): Promise<boolean>;
  cleanup(now: Date, limits: RelayConfig["limits"]): Promise<{
    eventsDeleted: number;
    noncesDeleted: number;
    attemptsDeleted: number;
    pairingsDeleted: number;
    subscriptionsDeleted: number;
  }>;
}
