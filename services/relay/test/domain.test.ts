import assert from "node:assert/strict";
import test from "node:test";
import { genericPushPayload, isExpired, shouldNotify, shouldRetryTransientPush } from "../src/domain.ts";

test("only watched transitions trigger a push", () => {
  const preferences = {
    alias: "重要任务",
    muted: false,
    notifyOn: ["task_completed", "attention_required"] as const,
  };
  assert.equal(shouldNotify({ ...preferences, notifyOn: [...preferences.notifyOn] }, "task_completed"), true);
  assert.equal(shouldNotify({ ...preferences, notifyOn: [...preferences.notifyOn] }, "task_started"), false);
  assert.equal(
    shouldNotify({ ...preferences, muted: true, notifyOn: [...preferences.notifyOn] }, "task_completed"),
    false,
  );
});

test("push copy contains only safe labels and opaque routing", () => {
  const payload = genericPushPayload({
    eventId: `evt_${"e".repeat(32)}`,
    eventType: "attention_required",
    taskId: "019feffc-3299-70d3-b1dd-1fb8472f5e6c",
    hostLabel: "Mac mini\n/private/path\u202Etxt.exe",
    taskAlias: null,
    appOrigin: "https://pulse.example",
  });
  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes("prompt"), false);
  assert.equal(serialized.includes("command"), false);
  assert.equal(serialized.includes("\n"), false);
  assert.equal(serialized.includes("/private/path"), false);
  assert.equal(serialized.includes("\u202E"), false);
  assert.equal(payload.web_push, 8030);
  assert.equal(
    payload.notification.data.url,
    `/tasks/019feffc-3299-70d3-b1dd-1fb8472f5e6c?event=evt_${"e".repeat(32)}`,
  );
});

test("expired offline events do not remain push-worthy", () => {
  const now = new Date("2026-08-11T08:10:01.000Z");
  assert.equal(isExpired("2026-08-11T08:00:00.000Z", 600, now), true);
  assert.equal(isExpired("2026-08-11T08:00:02.000Z", 600, now), false);
});

test("transient Push retries are bounded and stop after provider acceptance", () => {
  assert.equal(shouldRetryTransientPush({ acceptedAt: null, errorCategory: "push_transient_failure", attemptCount: 1 }), true);
  assert.equal(shouldRetryTransientPush({ acceptedAt: null, errorCategory: "push_transient_failure", attemptCount: 3 }), false);
  assert.equal(shouldRetryTransientPush({ acceptedAt: "2026-08-11T08:00:03.000Z", errorCategory: null, attemptCount: 1 }), false);
});
