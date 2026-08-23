import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const host = "127.0.0.1";
const port = Number(process.env.CODEXPULSE_PREVIEW_PORT || 4173);
const dist = join(process.cwd(), "apps/pwa/dist");
const now = Date.now();
const ago = (milliseconds) => new Date(now - milliseconds).toISOString();

const hostBook = "11111111-1111-4111-8111-111111111111";
const hostMini = "22222222-2222-4222-8222-222222222222";
const taskApproval = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const taskRunning = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const taskDone = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const taskStale = "ffffffff-ffff-4fff-8fff-ffffffffffff";

const config = {
  schemaVersion: 1,
  vapidPublicKey: "BMockPreviewKeyThatIsNeverUsedForAPushSubscription000000000000000000000000000000000000000000000",
  appOrigin: `http://${host}:${port}`,
  limits: { hosts: 2, subscriptions: 3, tasks: 200, events: 10_000, retentionDays: 7 },
};

const dashboard = {
  hosts: [
    {
      id: hostBook,
      label: "MacBook Pro",
      createdAt: ago(86_400_000),
      approvedAt: ago(86_000_000),
      lastSeenAt: ago(21_000),
      revokedAt: null,
      bridgeVersion: "0.1.0",
      queuedEventCount: 0,
      sourceHealth: [
        { source: "app_server", healthy: true, lastSuccessAt: ago(21_000), errorCategory: null },
        { source: "notify", healthy: true, lastSuccessAt: ago(420_000), errorCategory: null },
      ],
    },
    {
      id: hostMini,
      label: "Mac mini",
      createdAt: ago(172_800_000),
      approvedAt: ago(172_400_000),
      lastSeenAt: ago(46_000),
      revokedAt: null,
      bridgeVersion: "0.1.0",
      queuedEventCount: 0,
      sourceHealth: [
        { source: "app_server", healthy: true, lastSuccessAt: ago(46_000), errorCategory: null },
        { source: "notify", healthy: true, lastSuccessAt: ago(3_900_000), errorCategory: null },
        { source: "remote_cache", healthy: false, lastSuccessAt: ago(1_320_000), errorCategory: "temporary_failure" },
      ],
    },
  ],
  tasks: [
    {
      id: taskApproval,
      hostId: hostMini,
      hostLabel: "Mac mini",
      alias: "发布前检查",
      state: "needs_attention",
      attentionReason: "approval",
      source: "app_server",
      sourcePrecision: "live_status",
      sourceUpdatedAt: ago(68_000),
      observedAt: ago(68_000),
      relayReceivedAt: ago(67_000),
      unread: true,
      muted: false,
      notifyOn: ["task_completed", "task_failed", "attention_required", "attention_cleared"],
    },
    {
      id: taskRunning,
      hostId: hostBook,
      hostLabel: "MacBook Pro",
      alias: "Relay 安全测试",
      state: "running",
      attentionReason: null,
      source: "app_server",
      sourcePrecision: "polled_status",
      sourceUpdatedAt: ago(182_000),
      observedAt: ago(182_000),
      relayReceivedAt: ago(181_000),
      unread: false,
      muted: false,
      notifyOn: ["task_completed", "task_failed", "attention_required"],
    },
    {
      id: taskDone,
      hostId: hostBook,
      hostLabel: "MacBook Pro",
      alias: "PWA 手机验收",
      state: "completed",
      attentionReason: null,
      source: "notify",
      sourcePrecision: "event",
      sourceUpdatedAt: ago(480_000),
      observedAt: ago(480_000),
      relayReceivedAt: ago(479_000),
      unread: true,
      muted: false,
      notifyOn: ["task_completed", "task_failed"],
    },
    {
      id: taskStale,
      hostId: hostMini,
      hostLabel: "Mac mini",
      alias: "Remote 状态校准",
      state: "running",
      attentionReason: null,
      source: "remote_cache",
      sourcePrecision: "cached_summary",
      sourceUpdatedAt: ago(1_320_000),
      observedAt: ago(1_320_000),
      relayReceivedAt: ago(1_319_000),
      unread: false,
      muted: false,
      notifyOn: ["task_completed", "task_failed", "attention_required"],
    },
  ],
  events: [
    {
      id: `evt_${"d".repeat(32)}`,
      taskId: taskApproval,
      hostId: hostMini,
      hostLabel: "Mac mini",
      taskAlias: "发布前检查",
      type: "attention_required",
      reason: "approval",
      occurredAt: ago(68_000),
      observedAt: ago(68_000),
      receivedAt: ago(67_000),
      source: "app_server",
      sourcePrecision: "live_status",
      unread: true,
      pushAttemptedAt: ago(66_000),
      pushAcceptedAt: ago(65_000),
      openedAt: null,
      pushAttemptCount: 1,
      pushErrorCategory: null,
    },
    {
      id: `evt_${"e".repeat(32)}`,
      taskId: taskDone,
      hostId: hostBook,
      hostLabel: "MacBook Pro",
      taskAlias: "PWA 手机验收",
      type: "task_completed",
      reason: null,
      occurredAt: ago(480_000),
      observedAt: ago(480_000),
      receivedAt: ago(479_000),
      source: "notify",
      sourcePrecision: "event",
      unread: true,
      pushAttemptedAt: ago(478_000),
      pushAcceptedAt: ago(477_000),
      openedAt: ago(120_000),
      pushAttemptCount: 1,
      pushErrorCategory: null,
    },
  ],
  pairings: [],
  subscriptions: [],
  limits: config.limits,
  serverTime: new Date(now).toISOString(),
};

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

function json(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function serveFile(response, pathname) {
  const relative = pathname === "/" || pathname.startsWith("/tasks/") ? "index.html" : normalize(pathname).replace(/^\/+/, "");
  const candidate = join(dist, relative);
  if (!candidate.startsWith(`${dist}/`) && candidate !== join(dist, "index.html")) return false;
  try {
    if (!(await stat(candidate)).isFile()) return false;
    const data = await readFile(candidate);
    response.writeHead(200, {
      "content-type": contentTypes[extname(candidate)] || "application/octet-stream",
      "cache-control": relative === "sw.js" ? "no-cache" : "no-store",
    });
    response.end(data);
    return true;
  } catch {
    return false;
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || `${host}:${port}`}`);
  if (url.pathname === "/api/config") return json(response, 200, config);
  if (url.pathname === "/api/me") return json(response, 200, { authenticated: true });
  if (url.pathname === "/api/dashboard") return json(response, 200, { ...dashboard, serverTime: new Date().toISOString() });
  if (url.pathname === "/api/push/test") return json(response, 200, { attempted: 1, delivered: 1, disabled: 0, failed: 0 });
  if (url.pathname === "/api/push/subscriptions" && request.method === "POST") return json(response, 201, { id: "55555555-5555-4555-8555-555555555555", created: true });
  if (url.pathname.startsWith("/api/")) return json(response, 200, { ok: true });
  if (await serveFile(response, url.pathname)) return;
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Not found");
});

server.listen(port, host, () => {
  process.stdout.write(`CodexPulse synthetic preview: http://${host}:${port}\n`);
});
