# CodexPulse Architecture

状态：Single-source self-hostable implementation; active deployment and host/iPhone reliability remain unverified
版本：0.1  
目标：read-only notification MVP

## 1. Architecture principles

1. Host truth：任务在哪台机器执行，尽量在哪台机器采集。
2. Outbound only：Mac Bridge 主动连接 Relay，不开放公网入站。
3. Minimal data：只同步任务和事件元数据。
4. Versioned contract：内部格式先转换为稳定事件协议。
5. Source transparency：保留事件来源和精度。
6. Read-only first：不把批准或执行放进 MVP。
7. Graceful degradation：官方事件不可用时才使用内部缓存。

## 2. System context

    +-----------------------+       +-----------------------+
    | MacBook               |       | Mac mini              |
    | Codex / ChatGPT       |       | Codex / ChatGPT       |
    | macOS Bridge          |       | macOS Bridge          |
    +-----------+-----------+       +-----------+-----------+
                | outbound HTTPS                |
                +---------------+---------------+
                                |
                    +-----------v-----------+
                    | Authenticated Relay   |
                    | ingest / state / push |
                    +-----+-------------+---+
                          |             |
                    Web Push       HTTPS task API
                          |             |
                    +-----v-------------v---+
                    | iPhone Home Screen PWA|
                    +-----------------------+

## 3. Components

### 3.1 macOS Bridge

Responsibilities:

- discover supported Codex conversations;
- observe status and completion signals;
- normalize source-specific records;
- detect transitions;
- queue events during network loss;
- sign and publish events to Relay;
- install the notify hook as a transactional, TOML-valid config mutation with a private full-file backup, hashes and verified rollback;
- expose local health without exposing a network port.

Implemented sources:

- Codex notify hook;
- Codex App Server over stdio;

Deferred fallback sources:

- state_5.sqlite;
- rollout JSONL;
- thread writer locks;
- ChatGPT Desktop remote summary cache;
- Desktop IPC as an isolated experimental adapter.

Non-responsibilities:

- rendering mobile UI;
- storing push subscriptions;
- holding ChatGPT cookies;
- accepting remote shell commands.

### 3.2 Relay

Responsibilities:

- pair users, hosts and PWA devices;
- issue and revoke per-host credentials;
- authenticate and rate-limit event ingestion;
- provide idempotent event storage;
- maintain latest task projection;
- evaluate watch rules;
- send Web Push;
- expose authenticated task and health APIs;
- prune expired data.

Non-responsibilities:

- running Codex;
- storing full transcripts by default;
- translating private ChatGPT endpoints;
- forwarding arbitrary commands to hosts.

### 3.3 PWA

Responsibilities:

- installation guidance;
- notification permission and subscription;
- host pairing;
- Activity list and task detail;
- watch rules;
- notification click routing;
- connection and source freshness;
- revoke devices and clear data.

Runtime channels:

- foreground: HTTPS fetch, optionally SSE later;
- background: Web Push;
- offline: cached shell and last safe task projection.

### 3.4 Shared contracts

packages/contracts owns strict versioned JSON schemas for:

- TaskSnapshot;
- SnapshotBatch for projection repair;
- TaskEvent and IngestRequest;
- HostHeartbeat and source health;
- TaskPreferences;
- PushSubscriptionRegistration;
- SafePushPayload.

Both Relay and PWA validate incoming payloads. Bridge fixtures must be checked against the same schema.

## 4. Normalized task model

Implemented TaskSnapshot v1:

    schemaVersion: 1
    taskKey: tsk_ + host-secret-keyed opaque HMAC
    state: running | needs_attention | failed | completed | inactive | unknown
    attentionReason: approval | user_input | system_error | null
    source: notify | app_server | rollout | state_db | desktop_ipc | remote_cache
    sourcePrecision: event | live_status | polled_status | cached_summary
    sourceUpdatedAt: timestamp
    observedAt: timestamp
    expiresAt: timestamp or null
    revision: monotonic number per host

The raw conversation ID and its mapping to taskKey stay on the Bridge. Relay generates a UUID task ID for the PWA. Titles, prompts, repository identity and paths are not uploaded; the user may add a safe alias from the PWA.

## 5. Event model

Implemented TaskEvent v1:

    schemaVersion: 1
    eventId: deterministic idempotency key
    taskKey: stable task key
    type: task_started | attention_required | attention_cleared |
          task_completed | task_failed | task_updated | source_stale
    reason: approval | user_input | system_error | null
    occurredAt: event occurrence or transition-detection timestamp
    observedAt: bridge timestamp
    source: adapter name
    sourcePrecision: precision enum
    sequence: per-host monotonic sequence
    ttlSeconds: delivery lifetime

Event ID is an `evt_` HMAC derived from the host-scoped task key, event type, reason and stable source identity. It contains no raw prompt content.

`sourceUpdatedAt` preserves the source record's own timestamp. For a transition first detected by polling, `occurredAt` is the Bridge detection time rather than a possibly old thread metadata timestamp; `observedAt` records that same observation hop. This keeps TTL and latency calculations from expiring a newly detected event immediately while retaining the older source time for diagnosis.

## 6. State normalization

| Source value | Normalized state | Event behavior |
|---|---|---|
| active with no attention flags | running | task_started or task_updated |
| active + waitingOnApproval | needs_attention | attention_required approval |
| active + waitingOnUserInput | needs_attention | attention_required user_input |
| systemError | failed | task_failed |
| idle after live state | completed candidate | confirm with higher-quality event if possible |
| notLoaded without prior live state | unknown or inactive | no completion notification |
| agent-turn-complete | completed | authoritative completion event |
| turn/completed failed | failed | authoritative failure event |

Rule: notLoaded by itself must never trigger completion.

## 7. Source precedence

For the same task and time window:

1. App Server event or notify event;
2. host-local live status;
3. rollout lifecycle;
4. local state database and lock inference;
5. Desktop IPC;
6. Remote cache summary.

This precedence is not a blanket statement that internal IPC is worse than a cache in accuracy; it reflects maintainability. An adapter can expose both precision and stability so the projection policy can make explicit choices.

## 8. Data flow

### 8.1 Completion

1. Codex invokes notify or App Server emits turn/completed.
2. Bridge converts the source payload into TaskEvent.
3. Bridge redacts content and computes eventId.
4. Bridge stores the event in its outbound queue before network send.
5. Relay verifies signature, timestamp, nonce and schema.
6. Relay upserts task projection and deduplicates event.
7. Watch rules determine target PWA subscriptions.
8. Relay sends a generic Web Push and records request time plus Push-service acceptance or a content-free error category.
9. PWA opens `/tasks/:opaqueTaskId?event=:opaqueEventId`, fetches detail after authentication and marks that event opened from a notification; ordinary task-card reads do not set this metric.
10. The UI distinguishes Push-service acceptance from unobservable lock-screen presentation; real-device acceptance records the latter separately.

### 8.2 Waiting for approval

1. A live source reports waitingOnApproval.
2. Bridge requires a stable observation or high-quality event.
3. Relay sends attention_required once.
4. When the flag clears, Bridge sends attention_cleared.
5. PWA removes or updates the attention state.

Debounce and hysteresis should be measured in the Spike rather than guessed.

### 8.3 Reconnect

1. Bridge assigns a monotonically increasing sequence.
2. Offline events remain in a bounded local queue.
3. On reconnect, Bridge sends from the last acknowledged sequence.
4. Relay is idempotent by eventId.
5. Expired low-value events are dropped.
6. A current TaskSnapshot batch follows replay at least every five minutes to repair projection drift even when no transition event occurred.

## 9. Pairing and authentication

Suggested pairing:

1. 已登录的 PWA 创建 5 分钟、单次使用的 8 位配对码。
2. Bridge 提交配对码与安全主机标签，Relay 只返回 pending 状态。
3. PWA 明确确认标签后，Bridge 在固定 claim endpoint 上通过请求头提交高熵 claim token，并领取 32 字节 per-host secret；令牌不会进入 URL 或普通 access log，响应丢失时只有两分钟恢复窗口。
4. secret 写入 macOS Keychain；Relay 使用 AES-256-GCM 加密保存。
5. 每个 Bridge 请求包含 host ID、Unix 时间、随机 nonce、body SHA-256 与 HMAC-SHA256。
6. Relay 校验 5 分钟时钟窗口、签名和 nonce 唯一性，并支持单主机撤销。

Do not put a long-lived bearer token in a QR code that remains valid after pairing.

## 10. Push design

Notification payload:

- generic title such as Codex task completed;
- safe device label;
- optional user-approved task label;
- opaque task ID;
- HTTPS navigate URL;
- event type and badge count;
- no raw prompt, reply, command, diff or path.

The PWA should support both standard Service Worker handling and a standards-compatible declarative notification payload where supported.

Web Push is not used for silent state synchronization. The task detail API remains the source of truth.

The browser subscription and Relay registration are reconciled by the opaque Relay subscription ID. Permission plus a local `PushSubscription` alone is not reported as healthy. A successful Web Push request means the provider accepted it; it is not labeled as confirmed device presentation.

If every valid endpoint returns a transient provider failure, Relay returns a retriable 503 after durably storing the event. The Bridge keeps the same deterministic event in its queue; duplicate ingestion may retry Push up to three dispatches, but stops immediately after provider acceptance. Permanent 404/410 endpoints are disabled instead of retried.

## 11. Watch rules

The personal MVP stores preferences directly on each opaque task projection:

- selected event types: completed, failed, attention required and attention cleared;
- optional safe alias;
- mute switch;
- default `notify_on` is empty, so discovery never silently opts a task into Push;
- event ID idempotency guarantees one push even if notify and daemon retry concurrently.

Host-wide and project-wide rules are deferred until their data-minimization semantics are explicitly designed.

## 12. Freshness and health

Every task should display:

- last source update;
- last Bridge observation;
- last Relay receipt;
- source name;
- source precision;
- host online status.

Implemented health behavior:

- each task shows source update, Bridge observation, Relay receipt, source and precision;
- a host is shown online when its heartbeat is newer than 10 minutes;
- Bridge sends a heartbeat at most every five minutes and reports each adapter health;
- Bridge sends signed content-minimal snapshot repair batches every five minutes while App Server is healthy;
- running and needs-attention projections fail closed to “状态已过期” when the phone is offline, the host heartbeat is old, the matching source is unhealthy, or no Bridge observation has arrived for 10 minutes;
- cached sources remain explicitly labeled `cached_summary` if added later.

The 10-minute UI threshold allows one missed five-minute heartbeat and must be calibrated during the real-device Spike.

## 13. Deployment topology

### Personal MVP

- one Vercel Hobby project serving static PWA and Node Relay Function;
- one Neon Free Postgres project;
- one canonical HTTPS origin configured by the operator;
- one owner access token and signed HttpOnly session cookie;
- one or two Mac Bridges;
- up to three Push subscriptions to tolerate PWA reinstall;
- HTTPS, Web Push and seven-day event retention;
- daily Hobby-compatible cleanup cron;
- application caps: 2 hosts, 3 subscriptions, 200 tasks, 10,000 events.

### Later

- multiple users and organizations;
- regional relay;
- encrypted transcript opt-in;
- alternative notification channels;
- native iOS client if PWA reliability is insufficient.

## 14. Failure modes

| Failure | Expected behavior |
|---|---|
| Bridge stopped | host marked disconnected; no false live state |
| ChatGPT Desktop stopped | local source may continue; remote cache marked stale |
| Relay offline | Bridge queues bounded events |
| PWA subscription expired | Relay disables endpoint; PWA asks to resubscribe |
| Internal schema changed | adapter fails closed; health warning; other sources continue |
| Codex config is malformed, ambiguous or changes during notify installation | Bridge leaves the original bytes untouched, or restores the verified pre-install backup; Codex never receives a best-effort partial rewrite |
| Unsigned Bridge binary changes while paired | pair-time SHA-256 verification rejects every Keychain access before Security.framework is called; installer also refuses overwrite; owner revokes, resets with the old trusted binary, reinstalls and re-pairs |
| A running Codex task cached the previous notify hook | restore `config.toml`, stop launchd, temporarily remove the old executable path, then restart the task/Codex before installing and pairing the fixed binary |
| Duplicate source events | Relay idempotency suppresses extra push |
| Out-of-order events | sequence and occurredAt prevent projection regression |
| Focus suppresses alert | event remains in Activity; notification health explains limitation |

## 15. Future bidirectional actions

Remote approval and prompt sending are intentionally excluded. If reconsidered, architecture must add:

- user-presence proof;
- short-lived signed action challenge;
- exact command and permission display;
- host confirmation;
- expiry and replay protection;
- audit log;
- action-specific authorization;
- independent security review.

Do not reuse the read-only event credential for write actions.
