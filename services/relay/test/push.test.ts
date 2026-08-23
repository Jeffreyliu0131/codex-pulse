import assert from "node:assert/strict";
import test from "node:test";
import webPush from "web-push";
import { encryptString } from "../src/crypto.ts";
import { genericPushPayload } from "../src/domain.ts";
import { PushService } from "../src/push.ts";
import type { RelayConfig, RelayStore } from "../src/types.ts";

test("push fanout records provider acceptance and disables corrupt subscriptions", async () => {
  const originalSetVapidDetails = webPush.setVapidDetails;
  const originalSendNotification = webPush.sendNotification;
  const masterKey = Buffer.alloc(32, 7);
  const now = new Date("2026-08-12T12:00:00.000Z");
  const subscription = {
    endpoint: "https://push.example/subscription",
    expirationTime: null,
    keys: { auth: "auth-key", p256dh: "p256dh-key" },
  };
  const disabled: Array<{ id: string; category: string }> = [];
  const succeeded: string[] = [];
  let recorded: Parameters<RelayStore["recordEventPushResult"]>[0] | null = null;
  const store = {
    activePushSubscriptions: async () => [
      { id: "valid", payloadCiphertext: encryptString(JSON.stringify(subscription), masterKey) },
      { id: "corrupt", payloadCiphertext: "not-a-ciphertext" },
    ],
    markPushSuccess: async (id: string) => { succeeded.push(id); },
    disablePushSubscription: async (id: string, _at: Date, category: string) => { disabled.push({ id, category }); },
    recordEventPushResult: async (input: Parameters<RelayStore["recordEventPushResult"]>[0]) => { recorded = input; },
  } as unknown as RelayStore;
  const config = {
    masterKey,
    vapidSubject: "mailto:owner@example.com",
    vapidPublicKey: "test-public",
    vapidPrivateKey: "test-private",
  } as RelayConfig;

  try {
    webPush.setVapidDetails = (() => undefined) as typeof webPush.setVapidDetails;
    webPush.sendNotification = (async () => ({ statusCode: 201, body: "", headers: {} })) as unknown as typeof webPush.sendNotification;
    const service = new PushService(store, config);
    const result = await service.send(genericPushPayload({
      eventId: `evt_${"a".repeat(32)}`,
      eventType: "task_completed",
      taskId: "11111111-1111-4111-8111-111111111111",
      hostLabel: "Test Mac",
      taskAlias: null,
      appOrigin: "https://pulse.example",
    }), now);

    assert.deepEqual(result, { attempted: 2, delivered: 1, disabled: 1, failed: 0 });
    assert.deepEqual(succeeded, ["valid"]);
    assert.deepEqual(disabled, [{ id: "corrupt", category: "subscription_invalid" }]);
    const recordedResult = recorded as Parameters<RelayStore["recordEventPushResult"]>[0] | null;
    assert.ok(recordedResult);
    assert.equal(recordedResult.eventId, `evt_${"a".repeat(32)}`);
    assert.equal(recordedResult.attempted, 2);
    assert.equal(recordedResult.delivered, 1);
    assert.equal(recordedResult.errorCategory, null);
  } finally {
    webPush.setVapidDetails = originalSetVapidDetails;
    webPush.sendNotification = originalSendNotification;
  }
});
