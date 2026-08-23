import assert from "node:assert/strict";
import test from "node:test";
import {
  hasMatchingRelaySubscription,
  isHostOnline,
  isTaskStateStale,
  liveStateFreshnessMs,
} from "../src/health.ts";
import type { Dashboard, HostView, TaskView } from "../src/model.ts";

const now = Date.parse("2026-08-12T12:00:00.000Z");
const host: HostView = {
  id: "11111111-1111-4111-8111-111111111111",
  label: "Test Mac",
  createdAt: new Date(now - 20_000).toISOString(),
  approvedAt: new Date(now - 19_000).toISOString(),
  lastSeenAt: new Date(now - 30_000).toISOString(),
  revokedAt: null,
  bridgeVersion: "test",
  queuedEventCount: 0,
  sourceHealth: [{ source: "app_server", healthy: true, lastSuccessAt: new Date(now - 30_000).toISOString(), errorCategory: null }],
};
const task: TaskView = {
  id: "22222222-2222-4222-8222-222222222222",
  hostId: host.id,
  hostLabel: host.label,
  alias: null,
  state: "running",
  attentionReason: null,
  source: "app_server",
  sourcePrecision: "polled_status",
  sourceUpdatedAt: new Date(now - 30_000).toISOString(),
  observedAt: new Date(now - 30_000).toISOString(),
  relayReceivedAt: new Date(now - 29_000).toISOString(),
  unread: false,
  muted: false,
  notifyOn: [],
};

test("live state fails closed at the freshness boundary", () => {
  const dashboard = { hosts: [host] } as Pick<Dashboard, "hosts">;
  assert.equal(isTaskStateStale(task, dashboard, now, false), false);
  assert.equal(isTaskStateStale({ ...task, observedAt: new Date(now - liveStateFreshnessMs).toISOString() }, dashboard, now, false), true);
  assert.equal(isTaskStateStale(task, dashboard, now, true), true);
});

test("unhealthy source or host makes a live state stale", () => {
  assert.equal(isHostOnline(host, now), true);
  assert.equal(isHostOnline({ ...host, lastSeenAt: new Date(now - liveStateFreshnessMs).toISOString() }, now), false);
  const unhealthy = { ...host, sourceHealth: [{ ...host.sourceHealth[0], healthy: false }] };
  assert.equal(isTaskStateStale(task, { hosts: [unhealthy] }, now, false), true);
  assert.equal(isTaskStateStale({ ...task, state: "completed" }, { hosts: [unhealthy] }, now, true), false);
});

test("push health requires this browser registration to be active on Relay", () => {
  const subscriptions: Dashboard["subscriptions"] = [
    { id: "active", createdAt: new Date(now).toISOString(), lastSuccessAt: null, disabledAt: null },
    { id: "disabled", createdAt: new Date(now).toISOString(), lastSuccessAt: null, disabledAt: new Date(now).toISOString() },
  ];
  assert.equal(hasMatchingRelaySubscription("active", subscriptions), true);
  assert.equal(hasMatchingRelaySubscription("disabled", subscriptions), false);
  assert.equal(hasMatchingRelaySubscription(null, subscriptions), false);
});
