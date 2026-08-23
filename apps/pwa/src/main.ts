import "./styles.css";
import type { EventType, TaskState } from "@codexpulse/contracts";
import { api, ApiError } from "./api.ts";
import { hasMatchingRelaySubscription, isHostOnline, isTaskStateStale } from "./health.ts";
import { icon } from "./icons.ts";
import type {
  Dashboard,
  EventView,
  HostView,
  PublicConfig,
  Tab,
  TaskFilter,
  TaskView,
} from "./model.ts";

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

type NotificationHealth = "unsupported" | "needs_install" | "default" | "denied" | "disabled" | "enabled" | "stale";

interface AppState {
  authenticated: boolean;
  config: PublicConfig | null;
  dashboard: Dashboard | null;
  tab: Tab;
  filter: TaskFilter;
  selectedTaskId: string | null;
  refreshing: boolean;
  offline: boolean;
  notificationHealth: NotificationHealth;
  pairingCode: { code: string; expiresAt: string } | null;
  toast: string | null;
  serverClockOffsetMs: number;
}

const appRoot = document.querySelector<HTMLDivElement>("#app");
if (!appRoot) throw new Error("Missing application root");
const app: HTMLDivElement = appRoot;

const cachedDashboardKey = "codexpulse.safe-dashboard.v1";
const pushRegistrationKey = "codexpulse.push-registration.v1";
let installPrompt: InstallPromptEvent | null = null;
let refreshTimer: number | null = null;
let toastTimer: number | null = null;

const initialTask = location.pathname.match(/^\/tasks\/([0-9a-f-]{36})$/i)?.[1] ?? null;
const eventQuery = new URLSearchParams(location.search).get("event");
const initialEvent = eventQuery && /^evt_[A-Za-z0-9_-]{24,96}$/.test(eventQuery) ? eventQuery : null;
const state: AppState = {
  authenticated: false,
  config: null,
  dashboard: null,
  tab: "activity",
  filter: "all",
  selectedTaskId: initialTask,
  refreshing: false,
  offline: !navigator.onLine,
  notificationHealth: "default",
  pairingCode: null,
  toast: null,
  serverClockOffsetMs: 0,
};

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isStandalone(): boolean {
  return matchMedia("(display-mode: standalone)").matches ||
    ("standalone" in navigator && Boolean((navigator as Navigator & { standalone?: boolean }).standalone));
}

function relativeTime(value: string | null): string {
  if (!value) return "尚未连接";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "时间未知";
  const seconds = Math.max(0, Math.floor((nowMs() - timestamp) / 1000));
  if (seconds < 15) return "刚刚";
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function nowMs(): number {
  return Date.now() + state.serverClockOffsetMs;
}

function hostOnline(host: HostView): boolean {
  return isHostOnline(host, nowMs());
}

function taskIsStale(task: TaskView, dashboard: Dashboard): boolean {
  return isTaskStateStale(task, dashboard, nowMs(), state.offline);
}

const stateLabels: Record<TaskState, string> = {
  running: "运行中",
  needs_attention: "需要处理",
  failed: "失败",
  completed: "已完成",
  inactive: "未活动",
  unknown: "状态未知",
};

const sourceLabels: Record<TaskView["source"], string> = {
  notify: "Codex notify",
  app_server: "App Server",
  rollout: "Rollout",
  state_db: "本地状态库",
  desktop_ipc: "桌面状态",
  remote_cache: "Remote 缓存",
  synthetic: "测试事件",
};

const precisionLabels: Record<TaskView["sourcePrecision"], string> = {
  event: "事件",
  live_status: "实时",
  polled_status: "轮询",
  cached_summary: "缓存",
};

const eventLabels: Record<EventType, string> = {
  task_started: "开始运行",
  attention_required: "需要处理",
  attention_cleared: "阻塞解除",
  task_completed: "完成",
  task_failed: "失败",
  task_updated: "状态更新",
  source_stale: "来源过期",
};

const healthErrorLabels: Record<string, string> = {
  codex_not_found: "未找到 Codex CLI",
  app_server_timeout: "App Server 超时",
  app_server_disconnected: "App Server 已断开",
  relay_rejected: "Relay 拒绝上报",
  temporary_failure: "临时故障",
  push_transient_failure: "Push 服务临时失败",
  subscription_disabled: "订阅已失效",
  no_active_subscription: "没有有效订阅",
};

function sourceHealthLabel(source: HostView["sourceHealth"][number]["source"]): string {
  return source ? sourceLabels[source] : "未知来源";
}

function sourceHealthDetail(source: HostView["sourceHealth"][number]): string {
  if (source.healthy) return `最近成功 ${relativeTime(source.lastSuccessAt ?? null)}`;
  return source.errorCategory ? (healthErrorLabels[source.errorCategory] ?? source.errorCategory) : "来源不可用";
}

function eventDeliveryCopy(event: EventView): string {
  const opened = Boolean(event.openedAt);
  if (event.pushAcceptedAt) return opened ? "Push 服务已接收 · 已从通知打开" : "Push 服务已接收";
  if (event.pushErrorCategory) return `Push 未接收 · ${healthErrorLabels[event.pushErrorCategory] ?? event.pushErrorCategory}`;
  if (event.pushAttemptedAt || event.pushAttemptCount > 0) return "Push 未被服务接收";
  return opened ? "未触发 Push · 通知深链已打开" : "未触发 Push";
}

function taskLabel(task: TaskView): string {
  return task.alias || `任务 ${task.id.slice(0, 6).toUpperCase()}`;
}

function taskStateIcon(stateValue: TaskState): string {
  if (stateValue === "needs_attention") return icon("attention");
  if (stateValue === "failed") return icon("failed");
  if (stateValue === "completed") return icon("completed");
  if (stateValue === "running") return icon("play");
  return icon("inactive");
}

function showToast(message: string): void {
  state.toast = message;
  render();
  if (toastTimer != null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    state.toast = null;
    render();
  }, 2600);
}

function renderLogin(error = ""): void {
  app.innerHTML = `
    <main class="login-shell">
      <section class="login-card">
        <div class="login-brand">
          <div class="brand-mark" aria-hidden="true"><span></span></div>
          <div><p class="eyebrow">Private relay</p><h1>CodexPulse</h1></div>
        </div>
        <h2>任务状态，不再靠反复刷新。</h2>
        <p>登录你的私人 Relay。这里不会读取或保存 ChatGPT 密码、Prompt、回复和本机路径。</p>
        <form id="login-form">
          <div class="field">
            <label for="access-token">部署访问口令</label>
            <input id="access-token" name="token" type="password" autocomplete="current-password" placeholder="输入 PULSE_ACCESS_TOKEN" required />
          </div>
          ${error ? `<p class="form-error" role="alert">${escapeHtml(error)}</p>` : ""}
          <button class="primary-button wide" type="submit">安全登录</button>
        </form>
        <div class="privacy-note">
          ${icon("shield", 17)}
          <span>会话使用 Secure、HttpOnly Cookie。锁屏通知只包含通用状态和你确认过的安全标签。</span>
        </div>
      </section>
    </main>`;
}

function summaryPanel(dashboard: Dashboard): string {
  const attention = dashboard.tasks.filter((task) => task.state === "needs_attention" && !taskIsStale(task, dashboard)).length;
  const running = dashboard.tasks.filter((task) => task.state === "running" && !taskIsStale(task, dashboard)).length;
  const completed = dashboard.tasks.filter((task) => task.state === "completed").length;
  const stale = dashboard.tasks.filter((task) => taskIsStale(task, dashboard)).length;
  const activeHosts = dashboard.hosts.filter(hostOnline).length;
  const allHostsOnline = dashboard.hosts.length > 0 && activeHosts === dashboard.hosts.length;
  return `
    <section class="summary-panel">
      <div class="summary-top">
        <div>
          <p class="summary-kicker">现在需要你处理</p>
          <p class="summary-number">${attention}</p>
        </div>
        <span class="health-chip ${allHostsOnline ? "" : "warning"}">
          <span class="dot"></span>
          ${dashboard.hosts.length === 0 ? "等待主机" : `${activeHosts}/${dashboard.hosts.length} 主机在线`}
        </span>
      </div>
      <div class="summary-stats">
        <div class="mini-stat"><strong>${running}</strong><span>运行中</span></div>
        <div class="mini-stat"><strong>${completed}</strong><span>近期完成</span></div>
        <div class="mini-stat ${stale ? "warning" : ""}"><strong>${stale}</strong><span>状态过期</span></div>
      </div>
    </section>`;
}

function taskCard(task: TaskView, dashboard: Dashboard): string {
  const stale = taskIsStale(task, dashboard);
  const attention = stale ? "状态已过期" : task.attentionReason === "approval" ? "等待批准" : task.attentionReason === "user_input" ? "等待输入" : stateLabels[task.state];
  const displayState: TaskState = stale ? "unknown" : task.state;
  return `
    <button class="task-card state-${displayState} ${stale ? "stale" : ""} ${task.unread ? "unread" : ""}" data-action="open-task" data-task-id="${task.id}" type="button">
      <span class="state-icon">${taskStateIcon(displayState)}</span>
      <span class="task-copy">
        <strong>${escapeHtml(taskLabel(task))}</strong>
        <small>${escapeHtml(task.hostLabel)} · ${escapeHtml(attention)}</small>
      </span>
      <span class="task-time">${escapeHtml(relativeTime(task.observedAt))}</span>
    </button>`;
}

function filteredTasks(tasks: TaskView[], dashboard: Dashboard): TaskView[] {
  if (state.filter === "all") return tasks;
  if (state.filter === "stale") return tasks.filter((task) => taskIsStale(task, dashboard));
  if (state.filter === "attention") return tasks.filter((task) => task.state === "needs_attention" && !taskIsStale(task, dashboard));
  return tasks.filter((task) => task.state === state.filter && !taskIsStale(task, dashboard));
}

function activityView(dashboard: Dashboard): string {
  const tasks = filteredTasks(dashboard.tasks, dashboard);
  const filters: Array<[TaskFilter, string]> = [
    ["all", "全部"],
    ["attention", "需要处理"],
    ["running", "运行中"],
    ["completed", "已完成"],
    ["failed", "失败"],
    ["stale", "已过期"],
  ];
  return `
    ${summaryPanel(dashboard)}
    <div class="filter-row" role="tablist" aria-label="任务状态筛选">
      ${filters.map(([value, label]) => `<button class="filter-chip ${state.filter === value ? "active" : ""}" data-action="filter" data-filter="${value}" type="button" aria-selected="${state.filter === value}">${label}</button>`).join("")}
    </div>
    <div class="section-heading"><h2>任务脉搏</h2><span>${tasks.length} 个任务</span></div>
    <div class="task-list">
      ${tasks.length ? tasks.map((task) => taskCard(task, dashboard)).join("") : `
        <section class="empty-card">
          ${icon("empty", 32)}
          <h3>${dashboard.hosts.length ? "这里暂时很安静" : "先连接一台 Mac"}</h3>
          <p>${dashboard.hosts.length ? "符合当前筛选条件的任务会显示在这里。" : "前往“主机”生成配对码，让 Bridge 开始安全上报。"}</p>
        </section>`}
    </div>`;
}

function deviceCard(host: HostView, taskCount: number): string {
  const online = hostOnline(host);
  const healthySources = host.sourceHealth.filter((source) => source.healthy === true).length;
  return `
    <section class="device-card">
      <div class="device-head">
        <div class="device-title">
          <span class="device-glyph">${icon("devices")}</span>
          <div><strong>${escapeHtml(host.label)}</strong><small>${online ? "出站连接正常" : "连接已过期"}</small></div>
        </div>
        <span class="health-chip ${online ? "" : "warning"}"><span class="dot"></span>${online ? "在线" : "离线"}</span>
      </div>
      <div class="device-meta">
        <div class="meta-cell"><span>最后心跳</span><strong>${escapeHtml(relativeTime(host.lastSeenAt))}</strong></div>
        <div class="meta-cell"><span>任务</span><strong>${taskCount} 个</strong></div>
        <div class="meta-cell"><span>Bridge</span><strong>${escapeHtml(host.bridgeVersion || "待上报")}</strong></div>
        <div class="meta-cell"><span>健康来源</span><strong>${healthySources}/${host.sourceHealth.length}</strong></div>
      </div>
      <div class="source-health-list">
        ${host.sourceHealth.length ? host.sourceHealth.map((source) => `
          <div class="source-health-row ${source.healthy ? "" : "unhealthy"}">
            <span class="dot"></span>
            <span class="source-health-copy"><strong>${escapeHtml(sourceHealthLabel(source.source))}</strong><small>${escapeHtml(sourceHealthDetail(source))}</small></span>
          </div>`).join("") : `<p class="muted">Bridge 尚未上报来源诊断。</p>`}
      </div>
      ${host.queuedEventCount > 0 ? `<div class="queue-warning">${icon("attention", 16)}<span>这台主机有 ${host.queuedEventCount} 个事件等待 Relay 接收</span></div>` : ""}
      <button class="danger-button wide" data-action="revoke-host" data-host-id="${host.id}" type="button">撤销这台主机</button>
    </section>`;
}

function pairingCards(dashboard: Dashboard): string {
  const claimed = dashboard.pairings.filter((pairing) => pairing.status === "claimed");
  const pairingCode = state.pairingCode;
  return `
    ${pairingCode && Date.parse(pairingCode.expiresAt) > nowMs() ? `
      <section class="pair-card">
        <div class="pair-head"><div><h3>在 Mac Bridge 输入配对码</h3><p>5 分钟内有效；凭据只会在手机确认后下发一次。</p></div><span class="health-chip warning"><span class="dot"></span>待领取</span></div>
        <div class="pair-code" aria-label="配对码 ${pairingCode.code}">${pairingCode.code.slice(0, 4)} ${pairingCode.code.slice(4)}</div>
        <div class="pair-instruction">codex-pulse-bridge pair --relay ${escapeHtml(location.origin)} --code ${pairingCode.code} --label "Mac mini"</div>
      </section>` : ""}
    ${claimed.map((pairing) => `
      <section class="pair-card">
        <div class="pair-head"><div><h3>确认新主机</h3><p>只有你刚刚操作的 Mac 才应被批准。</p></div><span class="health-chip warning"><span class="dot"></span>待确认</span></div>
        <div class="device-title pair-device"><span class="device-glyph">${icon("devices")}</span><div><strong>${escapeHtml(pairing.claimedLabel || "未命名 Mac")}</strong><small>凭据尚未生效</small></div></div>
        <div class="pair-actions">
          <button class="secondary-button" data-action="reject-pairing" data-pairing-id="${pairing.id}" type="button">拒绝</button>
          <button class="primary-button" data-action="approve-pairing" data-pairing-id="${pairing.id}" type="button">确认连接</button>
        </div>
      </section>`).join("")}`;
}

function devicesView(dashboard: Dashboard): string {
  return `
    <div class="section-heading"><h2>已连接主机</h2><span>${dashboard.hosts.length}/${dashboard.limits.hosts}</span></div>
    <div class="device-list">
      ${dashboard.hosts.length ? dashboard.hosts.map((host) => deviceCard(host, dashboard.tasks.filter((task) => task.hostId === host.id).length)).join("") : `
        <section class="empty-card">${icon("devices", 32)}<h3>还没有主机</h3><p>MacBook 与 Mac mini 都需要各自运行一个 Bridge。</p></section>`}
    </div>
    <div class="section-heading"><h2>安全配对</h2><span>短时、单次</span></div>
    <div class="settings-stack">
      ${pairingCards(dashboard)}
      ${dashboard.hosts.length < dashboard.limits.hosts ? `<section class="setting-card"><div class="setting-head"><div><h3>添加 Mac 主机</h3><p>生成一次性 8 位配对码；Bridge 只建立出站 HTTPS。</p></div>${icon("plus")}</div><button class="primary-button wide" data-action="create-pairing" type="button">生成配对码</button></section>` : ""}
    </div>`;
}

function notificationCopy(): { title: string; body: string; action: string } {
  if (state.notificationHealth === "unsupported") return { title: "当前浏览器不支持 Push", body: "请使用支持 Web Push 的浏览器。", action: "不可用" };
  if (state.notificationHealth === "needs_install") return { title: "先添加到主屏幕", body: "iPhone 只有主屏幕 Web App 可以接收系统通知。", action: "查看安装方式" };
  if (state.notificationHealth === "denied") return { title: "通知权限已关闭", body: "请在系统设置中为 CodexPulse 打开通知。", action: "权限已关闭" };
  if (state.notificationHealth === "disabled") return { title: "系统提醒已停用", body: "系统权限仍在，但此设备没有活动订阅。", action: "重新开启" };
  if (state.notificationHealth === "enabled") return { title: "系统提醒已启用", body: "浏览器订阅与 Relay 注册一致，可发送被关注的状态变化。", action: "发送测试" };
  if (state.notificationHealth === "stale") return { title: "订阅需要修复", body: "通知权限存在，但浏览器订阅与 Relay 注册不一致。", action: "重新订阅" };
  return { title: "开启系统提醒", body: "只会在你点击后请求系统通知权限。", action: "开启通知" };
}

function settingsView(dashboard: Dashboard): string {
  const notification = notificationCopy();
  const installed = isStandalone();
  const registrationId = localStorage.getItem(pushRegistrationKey);
  const relaySubscription = registrationId
    ? dashboard.subscriptions.find((subscription) => subscription.id === registrationId && !subscription.disabledAt)
    : null;
  const relayStatus = relaySubscription
    ? `Relay 注册有效 · ${relaySubscription.lastSuccessAt ? `Push 服务最近接收于 ${relativeTime(relaySubscription.lastSuccessAt)}` : "等待首次测试"}`
    : state.notificationHealth === "stale"
      ? "Relay 注册缺失或已停用"
      : "此设备尚无有效 Relay 注册";
  return `
    <div class="section-heading"><h2>手机 App</h2><span>${installed ? "已安装" : "浏览器模式"}</span></div>
    <div class="settings-stack">
      <section class="setting-card">
        <div class="setting-head"><div><h3>${escapeHtml(notification.title)}</h3><p>${escapeHtml(notification.body)}</p></div>${icon("bell")}</div>
        <div class="registration-health ${relaySubscription ? "healthy" : ""}"><span class="dot"></span><span>${escapeHtml(relayStatus)}</span></div>
        <div class="setting-action">
          ${state.notificationHealth === "enabled" ? `<button class="secondary-button wide" data-action="test-push" type="button">${escapeHtml(notification.action)}</button><button class="quiet-button wide" data-action="disable-push" type="button">在此设备停用</button>` : `<button class="primary-button wide" data-action="enable-push" type="button" ${state.notificationHealth === "denied" || state.notificationHealth === "unsupported" ? "disabled" : ""}>${escapeHtml(notification.action)}</button>`}
        </div>
      </section>
      <section class="setting-card">
        <div class="setting-head"><div><h3>${installed ? "已作为主屏幕 App 运行" : "安装到手机主屏幕"}</h3><p>${installed ? "独立窗口、系统提醒和任务深链均可使用。" : "iPhone：Safari 分享 → 添加到主屏幕 → 从图标重新打开。"}</p></div>${icon("phone")}</div>
        ${installed ? "" : `<ol class="install-steps"><li>在 Safari 打开当前 HTTPS 地址</li><li>点击分享按钮</li><li>选择“添加到主屏幕”</li><li>从 CodexPulse 图标打开后启用通知</li></ol><button class="secondary-button wide" data-action="install-app" type="button">${installPrompt ? "立即安装" : "我知道了"}</button>`}
      </section>
      <section class="setting-card">
        <div class="setting-head"><div><h3>隐私与额度护栏</h3><p>7 天保留；最多 2 台主机、3 个手机订阅。不会自动切换付费计划。</p></div>${icon("shield")}</div>
        <button class="secondary-button wide" data-action="cleanup" type="button">立即清理过期数据</button>
      </section>
      <section class="setting-card">
        <div class="setting-head"><div><h3>退出这台手机</h3><p>停用此设备 Push，并清除本地只读缓存和登录 Cookie。</p></div>${icon("external")}</div>
        <button class="danger-button wide" data-action="logout" type="button">停用并安全退出</button>
      </section>
    </div>`;
}

function taskModal(task: TaskView, dashboard: Dashboard): string {
  const latestEvents = dashboard.events.filter((event) => event.taskId === task.id).slice(0, 5);
  const stale = taskIsStale(task, dashboard);
  const options: Array<[EventType, string]> = [
    ["task_completed", "任务完成"],
    ["task_failed", "任务失败"],
    ["attention_required", "等待批准或输入"],
    ["attention_cleared", "阻塞已解除"],
  ];
  const statusClass = stale ? "stale" : task.state === "needs_attention" ? "attention" : task.state === "failed" ? "failed" : "";
  const statusLabel = stale ? "状态已过期" : stateLabels[task.state];
  return `
    <div class="modal-backdrop" data-action="close-task">
      <section class="modal-sheet" role="dialog" aria-modal="true" aria-labelledby="task-title" data-modal>
        <div class="sheet-handle"></div>
        <div class="modal-head">
          <div><p class="eyebrow">${escapeHtml(task.hostLabel)}</p><h2 id="task-title">${escapeHtml(taskLabel(task))}</h2></div>
          <button class="close-button" data-action="close-task" type="button" aria-label="关闭">${icon("close")}</button>
        </div>
        <div class="detail-status">
          <span class="status-pill ${statusClass}"><span class="dot"></span>${escapeHtml(statusLabel)}</span>
          <span class="source-pill">${escapeHtml(sourceLabels[task.source])} · ${escapeHtml(precisionLabels[task.sourcePrecision])}</span>
        </div>
        ${stale ? `<div class="stale-warning">${icon("attention", 16)}<span>这个运行态已超过可信窗口，或主机/来源不可用。恢复新鲜观测前，不把它当作仍在运行或仍需处理。</span></div>` : ""}
        <div class="detail-grid">
          <div class="meta-cell"><span>来源更新</span><strong>${escapeHtml(relativeTime(task.sourceUpdatedAt))}</strong></div>
          <div class="meta-cell"><span>Bridge 观测</span><strong>${escapeHtml(relativeTime(task.observedAt))}</strong></div>
          <div class="meta-cell"><span>Relay 收到</span><strong>${escapeHtml(relativeTime(task.relayReceivedAt))}</strong></div>
          <div class="meta-cell"><span>注意原因</span><strong>${escapeHtml(task.attentionReason === "approval" ? "等待批准" : task.attentionReason === "user_input" ? "等待输入" : "无")}</strong></div>
          <div class="meta-cell"><span>隐私 ID</span><strong>${escapeHtml(task.id.slice(0, 8))}</strong></div>
        </div>
        <form id="task-preferences" data-task-id="${task.id}">
          <div class="field"><label for="task-alias">安全别名（可选）</label><input id="task-alias" name="alias" maxlength="64" value="${escapeHtml(task.alias || "")}" placeholder="例如：发布前检查" /></div>
          <div class="watch-options">
            ${options.map(([value, label]) => `<label class="check-row"><span>${label}</span><input type="checkbox" name="notifyOn" value="${value}" ${task.notifyOn.includes(value) ? "checked" : ""} /></label>`).join("")}
            <label class="check-row"><span>静音此任务</span><input type="checkbox" name="muted" ${task.muted ? "checked" : ""} /></label>
          </div>
          <button class="primary-button wide" type="submit">保存关注规则</button>
        </form>
        <div class="detail-divider"></div>
        <div class="section-heading"><h2>近期事件</h2><span>${latestEvents.length}</span></div>
        <div class="task-list">
          ${latestEvents.length ? latestEvents.map((event) => `<div class="task-card state-${event.type === "task_failed" ? "failed" : event.type === "attention_required" ? "needs_attention" : "completed"}"><span class="state-icon">${event.type === "task_failed" ? icon("failed") : event.type === "attention_required" ? icon("attention") : icon("completed")}</span><span class="task-copy"><strong>${escapeHtml(eventLabels[event.type])}</strong><small>${escapeHtml(sourceLabels[event.source])} · ${escapeHtml(eventDeliveryCopy(event))}</small></span><span class="task-time">${escapeHtml(relativeTime(event.receivedAt))}</span></div>`).join("") : `<p class="muted">尚无近期事件。</p>`}
        </div>
      </section>
    </div>`;
}

function bottomNav(dashboard: Dashboard): string {
  const unread = dashboard.events.filter((event) => event.unread).length;
  return `<nav class="bottom-nav" aria-label="主要导航">
    <button class="nav-item ${state.tab === "activity" ? "active" : ""}" data-action="tab" data-tab="activity" type="button" aria-current="${state.tab === "activity" ? "page" : "false"}">${icon("activity")}<span>动态</span>${unread ? `<span class="nav-badge">${Math.min(unread, 99)}</span>` : ""}</button>
    <button class="nav-item ${state.tab === "devices" ? "active" : ""}" data-action="tab" data-tab="devices" type="button" aria-current="${state.tab === "devices" ? "page" : "false"}">${icon("devices")}<span>主机</span></button>
    <button class="nav-item ${state.tab === "settings" ? "active" : ""}" data-action="tab" data-tab="settings" type="button" aria-current="${state.tab === "settings" ? "page" : "false"}">${icon("settings")}<span>设置</span></button>
  </nav>`;
}

function render(): void {
  if (!state.authenticated) {
    renderLogin();
    return;
  }
  const dashboard = state.dashboard;
  if (!dashboard) {
    app.innerHTML = `<main class="boot-shell"><div class="brand-mark" aria-hidden="true"><span></span></div><p>正在获取安全状态…</p></main>`;
    return;
  }

  const content = state.tab === "activity" ? activityView(dashboard) : state.tab === "devices" ? devicesView(dashboard) : settingsView(dashboard);
  const selected = state.selectedTaskId ? dashboard.tasks.find((task) => task.id === state.selectedTaskId) : null;
  app.innerHTML = `
    ${state.offline ? `<div class="offline-banner">当前离线，显示上次安全同步的状态</div>` : ""}
    <main class="app-shell">
      <header class="topbar">
        <div class="page-title"><div class="brand-mark" aria-hidden="true"><span></span></div><div><p class="eyebrow">Read-only radar</p><h1>CodexPulse</h1></div></div>
        <button class="sync-button ${state.refreshing ? "loading" : ""}" data-action="refresh" type="button" aria-label="刷新">${icon("refresh")}</button>
      </header>
      ${content}
    </main>
    ${bottomNav(dashboard)}
    ${selected ? taskModal(selected, dashboard) : ""}
    ${state.toast ? `<div class="toast" role="status">${escapeHtml(state.toast)}</div>` : ""}`;
}

async function refreshDashboard(silent = false): Promise<void> {
  if (!silent) {
    state.refreshing = true;
    render();
  }
  try {
    const dashboard = await api<Dashboard>("/api/dashboard");
    const serverTime = Date.parse(dashboard.serverTime);
    if (Number.isFinite(serverTime)) state.serverClockOffsetMs = serverTime - Date.now();
    state.dashboard = dashboard;
    state.offline = false;
    localStorage.setItem(cachedDashboardKey, JSON.stringify(dashboard));
    await updateBadge(dashboard.events.filter((event) => event.unread).length);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      state.authenticated = false;
      state.dashboard = null;
      render();
      return;
    }
    state.offline = true;
    if (!state.dashboard) {
      const cached = localStorage.getItem(cachedDashboardKey);
      if (cached) {
        try { state.dashboard = JSON.parse(cached) as Dashboard; } catch { localStorage.removeItem(cachedDashboardKey); }
      }
    }
  } finally {
    state.refreshing = false;
    render();
  }
}

async function updateNotificationHealth(): Promise<void> {
  if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
    state.notificationHealth = "unsupported";
    return;
  }
  if (!isStandalone() && /iPhone|iPad|iPod/i.test(navigator.userAgent)) {
    state.notificationHealth = "needs_install";
    return;
  }
  if (Notification.permission === "denied") {
    state.notificationHealth = "denied";
    return;
  }
  if (Notification.permission === "default") {
    state.notificationHealth = "default";
    return;
  }
  const registration = await readyServiceWorker();
  if (!registration) {
    state.notificationHealth = "stale";
    return;
  }
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    localStorage.removeItem(pushRegistrationKey);
    state.notificationHealth = "disabled";
    return;
  }
  const registrationId = localStorage.getItem(pushRegistrationKey);
  state.notificationHealth = hasMatchingRelaySubscription(
    registrationId,
    state.dashboard?.subscriptions ?? [],
  ) ? "enabled" : "stale";
}

async function readyServiceWorker(timeoutMs = 5_000): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (registration: ServiceWorkerRegistration | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(registration);
    };
    const timer = window.setTimeout(() => finish(null), timeoutMs);
    void navigator.serviceWorker.ready.then((registration) => finish(registration), () => finish(null));
  });
}

function applicationServerKey(value: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const decoded = atob((value + padding).replaceAll("-", "+").replaceAll("_", "/"));
  const output = new Uint8Array(new ArrayBuffer(decoded.length));
  for (let index = 0; index < decoded.length; index += 1) output[index] = decoded.charCodeAt(index);
  return output;
}

async function enablePush(): Promise<void> {
  if (state.notificationHealth === "needs_install") {
    state.tab = "settings";
    showToast("请先添加到主屏幕，再从图标打开");
    return;
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    await updateNotificationHealth();
    render();
    return;
  }
  if (!state.config) state.config = await api<PublicConfig>("/api/config");
  const registration = await readyServiceWorker();
  if (!registration) throw new Error("service_worker_unavailable");
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey(state.config.vapidPublicKey),
    });
  }
  const relayRegistration = await api<{ id: string; created: boolean }>("/api/push/subscriptions", {
    method: "POST",
    body: JSON.stringify(subscription.toJSON()),
  });
  localStorage.setItem(pushRegistrationKey, relayRegistration.id);
  await refreshDashboard(true);
  await updateNotificationHealth();
  showToast("系统提醒已启用");
}

async function disablePush(): Promise<void> {
  await removeCurrentPushSubscription();
  await updateNotificationHealth();
  await refreshDashboard(true);
  showToast("此设备的系统提醒已停用");
}

async function removeCurrentPushSubscription(): Promise<void> {
  const registrationId = localStorage.getItem(pushRegistrationKey);
  let subscription: PushSubscription | null = null;
  if (("serviceWorker" in navigator) && ("PushManager" in window)) {
    const registration = await readyServiceWorker();
    subscription = await registration?.pushManager.getSubscription() ?? null;
  }
  if (registrationId || subscription) {
    await api("/api/push/subscriptions", {
      method: "DELETE",
      body: JSON.stringify({ id: registrationId ?? undefined, endpoint: subscription?.endpoint }),
    });
  }
  if (subscription) await subscription.unsubscribe();
  localStorage.removeItem(pushRegistrationKey);
}

async function updateBadge(count: number): Promise<void> {
  const navigatorWithBadge = navigator as Navigator & {
    setAppBadge?: (value?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  try {
    if (count > 0) await navigatorWithBadge.setAppBadge?.(count);
    else await navigatorWithBadge.clearAppBadge?.();
  } catch {
    // Badging is optional and must never break task refresh.
  }
}

async function openTask(taskId: string): Promise<void> {
  state.selectedTaskId = taskId;
  history.pushState({}, "", `/tasks/${taskId}`);
  render();
  await markTaskEventRead(taskId).catch(() => undefined);
}

async function markTaskEventRead(taskId: string, preferredEventId: string | null = null): Promise<void> {
  if (preferredEventId) history.replaceState({}, "", `/tasks/${taskId}`);
  const unread = state.dashboard?.events.find((event) => (
    event.taskId === taskId && event.unread && (!preferredEventId || event.id === preferredEventId)
  ));
  if (unread) {
    await api(`/api/events/${unread.id}/read`, {
      method: "POST",
      body: JSON.stringify({ source: preferredEventId ? "notification" : "task" }),
    });
    await refreshDashboard(true);
  }
}

function closeTask(): void {
  state.selectedTaskId = null;
  history.pushState({}, "", "/");
  render();
}

app.addEventListener("submit", (event) => {
  const form = event.target as HTMLFormElement;
  if (form.id === "login-form") {
    event.preventDefault();
    const token = String(new FormData(form).get("token") ?? "");
    const button = form.querySelector<HTMLButtonElement>("button[type=submit]");
    if (button) button.disabled = true;
    void api("/api/session", { method: "POST", body: JSON.stringify({ token }) })
      .then(async () => {
        state.authenticated = true;
        await refreshDashboard();
        await updateNotificationHealth();
        render();
      })
      .catch((error: unknown) => {
        renderLogin(error instanceof ApiError ? "访问口令不正确，或请求过于频繁。" : "暂时无法连接 Relay。");
      });
    return;
  }

  if (form.id === "task-preferences") {
    event.preventDefault();
    const taskId = form.dataset.taskId;
    if (!taskId) return;
    const data = new FormData(form);
    const notifyOn = data.getAll("notifyOn").map(String) as EventType[];
    void api(`/api/tasks/${taskId}`, {
      method: "PATCH",
      body: JSON.stringify({
        alias: String(data.get("alias") ?? "").trim() || null,
        muted: data.get("muted") === "on",
        notifyOn,
      }),
    })
      .then(async () => {
        await refreshDashboard(true);
        showToast("关注规则已保存");
      })
      .catch(() => showToast("保存失败，请稍后重试"));
  }
});

app.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const button = target.closest<HTMLElement>("[data-action]");
  if (!button) return;
  if (button.dataset.action === "close-task" && target.closest("[data-modal]") && !target.closest(".close-button")) return;

  const action = button.dataset.action;
  if (action === "tab") {
    state.tab = button.dataset.tab as Tab;
    state.selectedTaskId = null;
    history.pushState({}, "", "/");
    if (state.tab === "settings") void updateNotificationHealth().then(render);
    render();
  } else if (action === "filter") {
    state.filter = button.dataset.filter as TaskFilter;
    render();
  } else if (action === "refresh") {
    void refreshDashboard();
  } else if (action === "open-task" && button.dataset.taskId) {
    void openTask(button.dataset.taskId);
  } else if (action === "close-task") {
    closeTask();
  } else if (action === "create-pairing") {
    void api<{ code: string; expiresAt: string }>("/api/pairings", { method: "POST", body: "{}" })
      .then(async (result) => {
        state.pairingCode = result;
        await refreshDashboard(true);
        showToast("一次性配对码已生成");
      })
      .catch(() => showToast("无法生成配对码"));
  } else if (action === "approve-pairing" && button.dataset.pairingId) {
    void api(`/api/pairings/${button.dataset.pairingId}/approve`, { method: "POST", body: "{}" })
      .then(async () => {
        state.pairingCode = null;
        await refreshDashboard(true);
        showToast("主机已安全连接");
      })
      .catch(() => showToast("确认失败或已达到两台主机上限"));
  } else if (action === "reject-pairing" && button.dataset.pairingId) {
    void api(`/api/pairings/${button.dataset.pairingId}/reject`, { method: "POST", body: "{}" })
      .then(() => refreshDashboard(true))
      .catch(() => showToast("拒绝操作未完成"));
  } else if (action === "revoke-host" && button.dataset.hostId) {
    const host = state.dashboard?.hosts.find((item) => item.id === button.dataset.hostId);
    if (!confirm(`撤销 ${host?.label ?? "这台主机"}？它之后的事件会被 Relay 拒绝。`)) return;
    void api(`/api/hosts/${button.dataset.hostId}/revoke`, { method: "POST", body: "{}" })
      .then(() => refreshDashboard(true))
      .catch(() => showToast("撤销失败"));
  } else if (action === "enable-push") {
    void enablePush().catch(() => showToast("通知订阅失败，请检查安装与网络状态"));
  } else if (action === "disable-push") {
    void disablePush().catch(() => showToast("暂时无法停用订阅"));
  } else if (action === "test-push") {
    void api<{ attempted: number; delivered: number; disabled: number; failed: number }>("/api/push/test", { method: "POST", body: "{}" })
      .then(async (result) => {
        await refreshDashboard(true);
        await updateNotificationHealth();
        if (result.delivered) showToast("Push 服务已接收测试通知");
        else if (result.failed) showToast("Push 服务暂时未接收，请稍后重试");
        else if (result.disabled) showToast("订阅已失效，请重新订阅");
        else showToast("Relay 没有有效手机订阅");
      })
      .catch(() => showToast("测试通知发送失败"));
  } else if (action === "install-app") {
    if (installPrompt) {
      void installPrompt.prompt().then(() => installPrompt?.userChoice).then(() => {
        installPrompt = null;
        render();
      });
    } else {
      showToast("请使用 Safari 的“分享 → 添加到主屏幕”");
    }
  } else if (action === "cleanup") {
    void api("/api/admin/cleanup", { method: "POST", body: "{}" })
      .then(async () => {
        await refreshDashboard(true);
        showToast("过期数据已清理");
      })
      .catch(() => showToast("清理未完成"));
  } else if (action === "logout") {
    void removeCurrentPushSubscription()
      .then(() => api("/api/session", { method: "DELETE", body: "{}" }))
      .then(() => {
        localStorage.removeItem(cachedDashboardKey);
        localStorage.removeItem(pushRegistrationKey);
        state.authenticated = false;
        state.dashboard = null;
        render();
      })
      .catch(() => showToast("无法安全退出，请恢复网络后重试"));
  }
});

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event as InstallPromptEvent;
  if (state.authenticated) render();
});

window.addEventListener("popstate", () => {
  state.selectedTaskId = location.pathname.match(/^\/tasks\/([0-9a-f-]{36})$/i)?.[1] ?? null;
  render();
});

window.addEventListener("online", () => {
  state.offline = false;
  void refreshDashboard(true);
});

window.addEventListener("offline", () => {
  state.offline = true;
  render();
});

async function boot(): Promise<void> {
  if ("serviceWorker" in navigator) {
    await navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
  }
  state.config = await api<PublicConfig>("/api/config").catch(() => null);
  try {
    await api("/api/me");
    state.authenticated = true;
    await refreshDashboard(true);
    await updateNotificationHealth();
    if (state.selectedTaskId) {
      await markTaskEventRead(state.selectedTaskId, initialEvent).catch(() => undefined);
    }
  } catch {
    state.authenticated = false;
  }
  render();
  refreshTimer = window.setInterval(() => {
    if (state.authenticated && document.visibilityState === "visible") void refreshDashboard(true);
  }, 30_000);
}

void boot();

window.addEventListener("pagehide", () => {
  if (refreshTimer != null) window.clearInterval(refreshTimer);
});
