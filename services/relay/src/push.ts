import webPush from "web-push";
import type { SafePushPayload } from "@codexpulse/contracts";
import { decryptString } from "./crypto.ts";
import type { RelayConfig, RelayStore } from "./types.ts";

interface WebPushError extends Error {
  statusCode?: number;
}

export class PushService {
  readonly #store: RelayStore;
  readonly #config: RelayConfig;

  constructor(store: RelayStore, config: RelayConfig) {
    this.#store = store;
    this.#config = config;
    webPush.setVapidDetails(
      config.vapidSubject,
      config.vapidPublicKey,
      config.vapidPrivateKey,
    );
  }

  async send(payload: SafePushPayload, now = new Date()): Promise<{
    attempted: number;
    delivered: number;
    disabled: number;
    failed: number;
  }> {
    const subscriptions = await this.#store.activePushSubscriptions();
    let delivered = 0;
    let disabled = 0;
    let failed = 0;

    await Promise.all(
      subscriptions.map(async (record) => {
        let subscription: webPush.PushSubscription;
        try {
          subscription = JSON.parse(
            decryptString(record.payloadCiphertext, this.#config.masterKey),
          ) as webPush.PushSubscription;
          if (!subscription.endpoint || !subscription.keys?.auth || !subscription.keys?.p256dh) {
            throw new Error("invalid_subscription");
          }
        } catch {
          disabled += 1;
          await this.#store.disablePushSubscription(record.id, now, "subscription_invalid");
          return;
        }
        try {
          await webPush.sendNotification(subscription, JSON.stringify(payload), {
            TTL: payload.notification.data.type === "test" ? 60 : 15 * 60,
            urgency:
              payload.notification.data.type === "attention_required" ||
              payload.notification.data.type === "task_failed"
                ? "high"
                : "normal",
            topic: payload.notification.data.eventId.slice(0, 32),
          });
          delivered += 1;
          await this.#store.markPushSuccess(record.id, now);
        } catch (error) {
          const statusCode = (error as WebPushError).statusCode;
          const permanent = statusCode === 404 || statusCode === 410;
          if (permanent) {
            disabled += 1;
            await this.#store.disablePushSubscription(record.id, now, "endpoint_expired");
          } else {
            failed += 1;
          }
        }
      }),
    );

    const eventId = payload.notification.data.eventId;
    if (/^evt_[A-Za-z0-9_-]{24,96}$/.test(eventId)) {
      const errorCategory = delivered > 0
        ? null
        : failed > 0
          ? "push_transient_failure"
          : disabled > 0
            ? "subscription_disabled"
            : "no_active_subscription";
      await this.#store.recordEventPushResult({
        eventId,
        attemptedAt: now,
        completedAt: new Date(),
        attempted: subscriptions.length,
        delivered,
        errorCategory,
      });
    }

    return { attempted: subscriptions.length, delivered, disabled, failed };
  }
}
