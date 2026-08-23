import type {
  AttentionReason,
  EventSource,
  EventType,
  SourcePrecision,
  TaskState,
} from "@codexpulse/contracts";

export interface PublicConfig {
  schemaVersion: 1;
  vapidPublicKey: string;
  appOrigin: string;
  limits: {
    hosts: number;
    subscriptions: number;
    tasks: number;
    events: number;
    retentionDays: number;
  };
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
  sourceHealth: Array<{
    source?: EventSource;
    healthy?: boolean;
    lastSuccessAt?: string | null;
    errorCategory?: string | null;
  }>;
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

export interface PairingView {
  id: string;
  status: "created" | "claimed" | "approved" | "rejected" | "consumed";
  claimedLabel: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface Dashboard {
  hosts: HostView[];
  tasks: TaskView[];
  events: EventView[];
  pairings: PairingView[];
  subscriptions: Array<{
    id: string;
    createdAt: string;
    lastSuccessAt: string | null;
    disabledAt: string | null;
  }>;
  limits: PublicConfig["limits"];
  serverTime: string;
}

export type Tab = "activity" | "devices" | "settings";
export type TaskFilter = "all" | "attention" | "running" | "completed" | "failed" | "stale";
