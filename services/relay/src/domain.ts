import type {
  EventType,
  SafePushPayload,
  TaskPreferences,
  TaskState,
} from "@codexpulse/contracts";

export function shouldNotify(preferences: TaskPreferences, type: EventType): boolean {
  return !preferences.muted && preferences.notifyOn.includes(type);
}

export function shouldRetryTransientPush(input: {
  acceptedAt: string | null;
  errorCategory: string | null;
  attemptCount: number;
}): boolean {
  return !input.acceptedAt && input.errorCategory === "push_transient_failure" && input.attemptCount < 3;
}

export function genericPushPayload(input: {
  eventId: string;
  eventType: EventType;
  taskId: string;
  hostLabel: string;
  taskAlias: string | null;
  appOrigin: string;
}): SafePushPayload {
  const host = safeLabel(input.hostLabel, "Mac");
  const alias = input.taskAlias ? safeLabel(input.taskAlias, "") : "";
  const target = alias ? `${host} · ${alias}` : host;

  const copy: Record<EventType, { title: string; body: string }> = {
    task_started: { title: "Codex 任务已开始", body: `${target} 正在运行` },
    attention_required: { title: "Codex 需要处理", body: `${target} 正在等待你` },
    attention_cleared: { title: "Codex 阻塞已解除", body: `${target} 不再等待处理` },
    task_completed: { title: "Codex 任务已完成", body: `${target} 有结果可查看` },
    task_failed: { title: "Codex 任务失败", body: `${target} 需要检查` },
    task_updated: { title: "Codex 状态已更新", body: `${target} 有新的状态` },
    source_stale: { title: "Codex 数据已过期", body: `${target} 暂时无法确认实时状态` },
  };

  const route = `/tasks/${input.taskId}?event=${encodeURIComponent(input.eventId)}`;
  return {
    web_push: 8030,
    notification: {
      ...copy[input.eventType],
      navigate: `${input.appOrigin}${route}`,
      lang: "zh-CN",
      dir: "ltr",
      silent: false,
      app_badge: "1",
      data: {
        schemaVersion: 1,
        taskId: input.taskId,
        eventId: input.eventId,
        type: input.eventType,
        url: route,
      },
    },
  };
}

export function testPushPayload(appOrigin: string): SafePushPayload {
  return {
    web_push: 8030,
    notification: {
      title: "CodexPulse 通知正常",
      body: "这是一条不包含任务内容的测试提醒",
      navigate: `${appOrigin}/?notification=test`,
      lang: "zh-CN",
      dir: "ltr",
      silent: false,
      app_badge: "1",
      data: {
        schemaVersion: 1,
        taskId: null,
        eventId: `test_${Date.now()}`,
        type: "test",
        url: "/?notification=test",
      },
    },
  };
}

export function safeLabel(value: string, fallback: string): string {
  const compact = value
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]+/g, " ")
    .replace(/[\\/:]+/g, " · ")
    .replace(/https?:\/\//gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!compact) return fallback;
  return [...compact].slice(0, 48).join("");
}

export function statePriority(state: TaskState): number {
  return {
    needs_attention: 0,
    failed: 1,
    running: 2,
    completed: 3,
    inactive: 4,
    unknown: 5,
  }[state];
}

export function isExpired(occurredAt: string, ttlSeconds: number, now: Date): boolean {
  const sourceTime = Date.parse(occurredAt);
  return !Number.isFinite(sourceTime) || sourceTime + ttlSeconds * 1000 <= now.getTime();
}
