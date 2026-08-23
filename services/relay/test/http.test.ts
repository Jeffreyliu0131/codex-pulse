import assert from "node:assert/strict";
import test from "node:test";
import type { IngestRequest, SafePushPayload } from "@codexpulse/contracts";
import {
  canonicalHostRequest,
  encryptString,
  hmacBase64url,
  sha256,
} from "../src/crypto.ts";
import { createRelayHandler } from "../src/http.ts";
import type { PushService } from "../src/push.ts";
import type { RelayConfig, RelayStore } from "../src/types.ts";

const now = new Date("2026-08-11T08:00:00.000Z");
const hostId = "019feffc-3299-70d3-b1dd-1fb8472f5e6c";
const hostSecret = Buffer.from("cross-language-host-secret").toString("base64url");
const masterKey = Buffer.alloc(32, 9);
const seenNonces = new Set<string>();
const pushed: SafePushPayload[] = [];
let pushDelivery = { attempted: 1, delivered: 1, disabled: 0, failed: 0 };
let repairedSnapshots = 0;
let removedSubscriptionId: string | null = null;
let openedFromNotification = false;

const config: RelayConfig = {
  appOrigin: "https://pulse.example",
  accessToken: "access-token-with-at-least-thirty-two-characters",
  sessionSecret: "session-secret-with-at-least-thirty-two-characters",
  masterKey,
  vapidPublicKey: "public",
  vapidPrivateKey: "private",
  vapidSubject: "mailto:owner@example.com",
  cronSecret: "cron-secret-with-at-least-thirty-two-characters",
  databaseUrl: "postgresql://unused",
  nodeEnv: "test",
  limits: { hosts: 2, subscriptions: 3, tasks: 200, events: 10_000, retentionDays: 7 },
};

const store = {
  async recordRateLimitAttempt() { return 1; },
  async getHostSecret() {
    return {
      id: hostId,
      label: "Mac mini",
      secretCiphertext: encryptString(hostSecret, masterKey),
      approvedAt: now.toISOString(),
      revokedAt: null,
    };
  },
  async registerHostNonce(_hostId: string, nonce: string) {
    if (seenNonces.has(nonce)) return false;
    seenNonces.add(nonce);
    return true;
  },
  async ingest(_hostId: string, body: IngestRequest) {
    return {
      accepted: true,
      duplicate: false,
      taskId: "11111111-1111-4111-8111-111111111111",
      shouldNotify: true,
      hostLabel: "Mac mini",
      taskAlias: null,
      event: body.event,
    };
  },
  async upsertSnapshots(_hostId: string, body: { snapshots: unknown[] }) {
    repairedSnapshots += body.snapshots.length;
    return body.snapshots.length;
  },
  async getPairingClaim(claimTokenHash: string) {
    if (claimTokenHash !== sha256("c".repeat(43))) return null;
    return {
      pairingId: "33333333-3333-4333-8333-333333333333",
      status: "approved" as const,
      hostId,
      hostLabel: "Mac mini",
      secretCiphertext: encryptString(hostSecret, masterKey),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      credentialDeliveredAt: null,
    };
  },
  async markCredentialDelivered() {},
  async removePushSubscription() { return false; },
  async removePushSubscriptionById(id: string) {
    removedSubscriptionId = id;
    return true;
  },
  async markEventRead(_id: string, _at: Date, fromNotification: boolean) {
    openedFromNotification = fromNotification;
    return true;
  },
} as unknown as RelayStore;

const push = {
  async send(payload: SafePushPayload) {
    pushed.push(payload);
    return pushDelivery;
  },
} as unknown as PushService;

const handler = createRelayHandler({ store, config, push, now: () => now });

test("owner login requires exact origin and returns only an HttpOnly session", async () => {
  const rejected = await handler(new Request("https://pulse.example/api/session", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example" },
    body: JSON.stringify({ token: config.accessToken }),
  }));
  assert.equal(rejected.status, 403);

  const accepted = await handler(new Request("https://pulse.example/api/session", {
    method: "POST",
    headers: { "content-type": "application/json", origin: config.appOrigin },
    body: JSON.stringify({ token: config.accessToken }),
  }));
  assert.equal(accepted.status, 200);
  const cookie = accepted.headers.get("set-cookie") ?? "";
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);
  assert.equal((await accepted.text()).includes(config.accessToken), false);
});

test("owner can revoke a Push registration by opaque Relay ID", async () => {
  removedSubscriptionId = null;
  const login = await handler(new Request("https://pulse.example/api/session", {
    method: "POST",
    headers: { "content-type": "application/json", origin: config.appOrigin },
    body: JSON.stringify({ token: config.accessToken }),
  }));
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  const subscriptionId = "44444444-4444-4444-8444-444444444444";
  const response = await handler(new Request("https://pulse.example/api/push/subscriptions", {
    method: "DELETE",
    headers: { "content-type": "application/json", origin: config.appOrigin, cookie },
    body: JSON.stringify({ id: subscriptionId }),
  }));
  assert.equal(response.status, 200);
  assert.equal(removedSubscriptionId, subscriptionId);
});

test("notification deep links are distinguished from ordinary task reads", async () => {
  openedFromNotification = false;
  const login = await handler(new Request("https://pulse.example/api/session", {
    method: "POST",
    headers: { "content-type": "application/json", origin: config.appOrigin },
    body: JSON.stringify({ token: config.accessToken }),
  }));
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  const eventId = `evt_${"o".repeat(32)}`;
  const response = await handler(new Request(`https://pulse.example/api/events/${eventId}/read`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: config.appOrigin, cookie },
    body: JSON.stringify({ source: "notification" }),
  }));
  assert.equal(response.status, 200);
  assert.equal(openedFromNotification, true);
});

test("signed ingest validates the cross-language key and emits safe push once", async () => {
  seenNonces.clear();
  pushed.length = 0;
  pushDelivery = { attempted: 1, delivered: 1, disabled: 0, failed: 0 };
  const body: IngestRequest = {
    schemaVersion: 1,
    event: {
      schemaVersion: 1,
      eventId: `evt_${"e".repeat(32)}`,
      taskKey: `tsk_${"t".repeat(32)}`,
      type: "task_completed",
      reason: null,
      occurredAt: now.toISOString(),
      observedAt: now.toISOString(),
      source: "notify",
      sourcePrecision: "event",
      sequence: 1,
      ttlSeconds: 86_400,
    },
    snapshot: {
      schemaVersion: 1,
      taskKey: `tsk_${"t".repeat(32)}`,
      state: "completed",
      attentionReason: null,
      source: "notify",
      sourcePrecision: "event",
      sourceUpdatedAt: now.toISOString(),
      observedAt: now.toISOString(),
      expiresAt: null,
      revision: 1,
    },
  };
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const nonce = "nonce_nonce_nonce_http_1";
  const bodyHash = sha256(raw);
  const signature = hmacBase64url(
    Buffer.from(hostSecret, "base64url"),
    canonicalHostRequest({
      method: "POST",
      path: "/api/bridge/events",
      timestamp,
      nonce,
      bodyHash,
    }),
  );
  const makeRequest = () => new Request("https://pulse.example/api/bridge/events", {
    method: "POST",
    body: raw,
    headers: {
      "content-type": "application/json",
      "x-pulse-host-id": hostId,
      "x-pulse-timestamp": timestamp,
      "x-pulse-nonce": nonce,
      "x-pulse-body-sha256": bodyHash,
      "x-pulse-signature": signature,
    },
  });

  const accepted = await handler(makeRequest());
  assert.equal(accepted.status, 200);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0]?.notification.data.taskId, "11111111-1111-4111-8111-111111111111");
  assert.equal(JSON.stringify(pushed[0]).includes("cross-language-host-secret"), false);

  const replay = await handler(makeRequest());
  assert.equal(replay.status, 401);
  assert.equal(pushed.length, 1);

  const transientNonce = "nonce_nonce_nonce_http_2";
  const transientSignature = hmacBase64url(
    Buffer.from(hostSecret, "base64url"),
    canonicalHostRequest({
      method: "POST",
      path: "/api/bridge/events",
      timestamp,
      nonce: transientNonce,
      bodyHash,
    }),
  );
  pushDelivery = { attempted: 1, delivered: 0, disabled: 0, failed: 1 };
  const transient = await handler(new Request("https://pulse.example/api/bridge/events", {
    method: "POST",
    body: raw,
    headers: {
      "content-type": "application/json",
      "x-pulse-host-id": hostId,
      "x-pulse-timestamp": timestamp,
      "x-pulse-nonce": transientNonce,
      "x-pulse-body-sha256": bodyHash,
      "x-pulse-signature": transientSignature,
    },
  }));
  assert.equal(transient.status, 503);
  pushDelivery = { attempted: 1, delivered: 1, disabled: 0, failed: 0 };
});

test("pairing credential polling keeps the claim token out of the URL", async () => {
  const claimToken = "c".repeat(43);
  const accepted = await handler(new Request("https://pulse.example/api/pairings/claim", {
    headers: { "x-pulse-claim-token": claimToken },
  }));
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json() as { hostSecret: string }).hostSecret, hostSecret);

  const legacyPath = await handler(new Request(`https://pulse.example/api/pairings/claim/${claimToken}`));
  assert.equal(legacyPath.status, 404);
});

test("signed snapshot repair refreshes projections without creating events", async () => {
  seenNonces.clear();
  repairedSnapshots = 0;
  const raw = JSON.stringify({
    schemaVersion: 1,
    snapshots: [{
      schemaVersion: 1,
      taskKey: `tsk_${"s".repeat(32)}`,
      state: "running",
      attentionReason: null,
      source: "app_server",
      sourcePrecision: "polled_status",
      sourceUpdatedAt: now.toISOString(),
      observedAt: now.toISOString(),
      expiresAt: null,
      revision: 2,
    }],
  });
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const nonce = "nonce_nonce_snapshot_001";
  const bodyHash = sha256(raw);
  const signature = hmacBase64url(
    Buffer.from(hostSecret, "base64url"),
    canonicalHostRequest({
      method: "POST",
      path: "/api/bridge/snapshots",
      timestamp,
      nonce,
      bodyHash,
    }),
  );
  const response = await handler(new Request("https://pulse.example/api/bridge/snapshots", {
    method: "POST",
    body: raw,
    headers: {
      "content-type": "application/json",
      "x-pulse-host-id": hostId,
      "x-pulse-timestamp": timestamp,
      "x-pulse-nonce": nonce,
      "x-pulse-body-sha256": bodyHash,
      "x-pulse-signature": signature,
    },
  }));
  assert.equal(response.status, 200);
  assert.equal(repairedSnapshots, 1);
});
