import type { Dashboard, HostView, TaskView } from "./model.ts";

export const liveStateFreshnessMs = 10 * 60 * 1000;

export function isHostOnline(host: HostView, nowMs: number): boolean {
  if (host.revokedAt || !host.lastSeenAt) return false;
  const lastSeenAt = Date.parse(host.lastSeenAt);
  return Number.isFinite(lastSeenAt) && nowMs - lastSeenAt < liveStateFreshnessMs;
}

export function isTaskStateStale(
  task: TaskView,
  dashboard: Pick<Dashboard, "hosts">,
  nowMs: number,
  offline: boolean,
): boolean {
  if (task.state !== "running" && task.state !== "needs_attention") return false;
  if (offline) return true;
  const host = dashboard.hosts.find((candidate) => candidate.id === task.hostId);
  if (!host || !isHostOnline(host, nowMs)) return true;
  const sourceHealth = host.sourceHealth.find((source) => source.source === task.source);
  if (sourceHealth?.healthy === false) return true;
  const observedAt = Date.parse(task.observedAt);
  return !Number.isFinite(observedAt) || nowMs - observedAt >= liveStateFreshnessMs;
}

export function hasMatchingRelaySubscription(
  registrationId: string | null,
  subscriptions: Dashboard["subscriptions"],
): boolean {
  return Boolean(
    registrationId && subscriptions.some((subscription) => (
      subscription.id === registrationId && !subscription.disabledAt
    )),
  );
}
