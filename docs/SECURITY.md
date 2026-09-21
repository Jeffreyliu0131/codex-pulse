# CodexPulse Security and Privacy

状态：Controls implemented for personal MVP; live penetration and device validation pending  
适用范围：read-only MVP

## 1. Security objective

Deliver useful task notifications without turning CodexPulse into a path for:

- ChatGPT account theft;
- remote command execution;
- transcript leakage;
- repository or filesystem discovery;
- push spam;
- cross-device identity confusion.

## 2. Trust zones

### Trusted host

The user-owned Mac can read local Codex state. The Bridge runs with the user's permissions and must minimize what leaves the host.

### Relay

The Relay is network-accessible and must be treated as potentially observable by operators or attackers. It should receive only the data needed for notification and UI.

### Push service

The browser vendor push service receives message metadata and encrypted push content. Lock-screen content may be visible to anyone with physical access.

### PWA device

The iPhone may be lost, shared, locked, Focus-controlled or have notifications exposed on the lock screen.

## 3. Data classification

### Forbidden in Relay or Push by default

- ChatGPT auth tokens and cookies;
- Codex auth.json;
- OpenAI API keys;
- private Web Push keys;
- full prompts and assistant responses;
- command text;
- tool arguments;
- file diffs and code;
- rollout log lines;
- absolute local paths;
- full repository URLs;
- environment variables;
- shell output.

### Allowed with minimization

- opaque user ID;
- opaque host ID;
- user-defined device label;
- opaque task ID;
- normalized state;
- attention reason;
- safe user-approved task label;
- source type and precision;
- event and freshness timestamps;
- unread state;
- delivery health.

### Local-only

- raw conversation ID unless needed for a verified handoff;
- local database and file paths;
- adapter diagnostics containing schema details;
- mapping from raw task identity to opaque Relay ID.

## 4. Push payload policy

Default completion example:

Title: Codex task completed  
Body: Mac mini has a result ready for review  
Navigate: an authenticated CodexPulse HTTPS task URL

Default attention example:

Title: Codex needs your input  
Body: A watched task on MacBook is waiting  
Navigate: an authenticated CodexPulse HTTPS task URL

Do not include task content simply because notify provides it.

## 5. Pairing

Requirements:

- pairing code expires quickly;
- pairing code is single-use;
- user must confirm the target host label;
- each Bridge creates its own key;
- the high-entropy claim token is sent in a dedicated request header on a fixed endpoint, never in the URL;
- public key or derived credential is bound to one user and host;
- credentials can be rotated and revoked;
- QR code must not contain a reusable long-lived secret;
- failed attempts are rate-limited.

Preferred request authentication:

- host ID;
- timestamp;
- unique nonce;
- body digest;
- signature;
- bounded clock skew;
- replay cache.

## 6. Bridge hardening

- store private keys in macOS Keychain;
- bind each host credential to the SHA-256 fingerprint of the executable used at pairing, and verify it before every Keychain read or delete;
- never overwrite a Keychain credential during pairing; duplicate host accounts fail closed and require a fresh pairing code;
- never permit daemon or notify subprocesses to open Keychain authorization UI; reject missing/mismatched fingerprints before calling Security.framework and retain noninteractive LocalAuthentication as defense in depth;
- run with minimum needed filesystem access;
- never log raw source payloads in production;
- use outbound HTTPS only;
- validate Relay certificate;
- bound offline queue size and retention;
- encrypt sensitive local queue records if they contain identifiers;
- fail closed when a source schema is unexpected;
- mutate the user-level Codex config only after strict top-level `notify` parsing, save a private full-file backup and hashes, and verify both installation and rollback bytes;
- preserve an explicit uninstall and credential revoke flow;
- do not expose App Server WebSocket publicly;
- do not bind a local HTTP server to all interfaces.

## 7. Relay hardening

- validate schema before processing;
- reject stale timestamp and nonce reuse;
- enforce host and user ownership;
- make ingestion idempotent;
- rate-limit pairing, ingestion and push;
- encrypt server-side secrets;
- separate Web Push private key from application logs;
- use least-privilege database access;
- avoid storing request bodies in infrastructure logs;
- expire events and inactive subscriptions;
- provide per-device revoke and account-wide revoke;
- record security audit events without task content.

## 8. PWA hardening

- serve only over HTTPS;
- use a restrictive Content Security Policy;
- avoid third-party analytics in the MVP;
- store minimal local state;
- treat push navigate URLs as untrusted input and restrict them to same origin;
- require reauthentication for device management;
- show notification permission and subscription status;
- support clear local data and sign out;
- do not place sensitive data in URL query parameters;
- use feature detection for Push and Badging APIs.

## 9. Threats and mitigations

| Threat | Example | Mitigation |
|---|---|---|
| Stolen pairing code | attacker binds a host | short TTL, single use, confirmation, rate limit |
| Event forgery | attacker sends fake completion | signed requests, nonce, ownership checks |
| Replay | valid event sent repeatedly | eventId idempotency, nonce cache, sequence |
| Lock-screen leakage | task text exposed | generic push content |
| Relay breach | task metadata stolen | minimization, opaque IDs, short retention |
| Host compromise | Bridge key stolen | Keychain, revoke, per-host keys |
| Cross-host collision | same thread ID | host + conversation identity |
| Schema confusion | internal format changes | strict adapter validation, fail closed |
| Push endpoint leak | spam or tracking | protect subscription, revoke on failure |
| Future write abuse | malicious approval | out of scope; separate credential and review |

## 10. Logging

Allowed log fields:

- request ID;
- opaque host ID;
- opaque task ID;
- event type;
- source type;
- status code;
- latency;
- redacted error category.

Forbidden log fields:

- raw event payload;
- prompt or response;
- command and tool arguments;
- local paths;
- credentials;
- push subscription keys;
- full exception dumps containing source data.

## 11. Retention

Implemented MVP defaults (see [architecture](ARCHITECTURE.md)):

- latest task projection: active tasks plus seven days of recent history;
- events: seven days maximum and a 10,000-row application cap;
- push delivery logs: aggregate metrics or short retention;
- per-event delivery fields contain timestamps, attempt counts and content-free error categories only; Push-service acceptance is not treated as proof of lock-screen presentation;
- pairing sessions: minutes;
- expired subscriptions: delete promptly;
- raw source payloads: never retain.

Daily cleanup runs through a Vercel Hobby-compatible cron and can also be triggered by the authenticated owner.

## 12. Incident and recovery

The system must support:

- revoke one Bridge;
- revoke all hosts;
- revoke one PWA subscription;
- rotate Relay signing or push keys;
- invalidate all pairing sessions;
- disable push while retaining task view;
- wipe server-side task metadata;
- uninstall Bridge and restore the complete pre-install Codex config when unchanged, or only the prior `notify` line when later unrelated settings must be preserved.

## 13. Future approvals

Approval from a phone would change the threat model from notification to remote execution.

Before implementation it requires:

- explicit product decision;
- command-specific display;
- user-presence proof;
- short-lived action token;
- challenge bound to host, task, turn and exact action;
- expiration and one-time use;
- independent write credential;
- host-side final validation;
- immutable audit record;
- security review and abuse tests.

Until all are present, the PWA must remain read-only.

## 14. Security acceptance checklist

Implemented and covered by source tests or static inspection:

- [x] normalized contracts reject raw/unversioned extra content;
- [x] push builder contains only generic copy, safe labels and opaque IDs;
- [x] pairing code is single-use and expires after five minutes; an approved high-entropy claim token has only a two-minute response-recovery window;
- [x] the claim token is absent from pairing-poll URLs and ordinary infrastructure access paths;
- [x] Bridge requests are body-bound HMACs with timestamp and nonce replay rejection;
- [x] event IDs are idempotent and host scoped;
- [x] Service Worker routes notification clicks to the same origin only;
- [x] Relay supports host and Push subscription revocation;
- [x] offline queue is TTL-pruned and bounded to 1,000 events;
- [x] notify installation requires consent, emits TOML-valid strings, chains the previous command, stores a mode-0600 full backup plus hashes, and verifies install/rollback bytes;
- [x] paired unsigned Bridge binaries cannot be overwritten by the installer, pair-time executable fingerprints gate every Keychain access, and background reads retain noninteractive authentication as defense in depth;
- [x] App Server schema errors become content-free source health categories;
- [x] fixtures and UI preview data are synthetic;
- [x] PWA never caches `/api/*` responses;
- [x] owner mutations require exact Origin plus a SameSite=Strict signed session.
- [x] production configuration rejects placeholder/non-canonical origins, malformed key material, reused secrets and missing cron authentication;
- [x] active UI states fail closed when host, source or observation freshness is no longer trustworthy;

Still required on the target environment:

- [x] compile/link the Bridge and pass the 25-check standalone Swift self-test;
- [ ] run the mirrored XCTest suite when full Xcode is available;
- [ ] verify the per-host secret is stored and retrieved from Keychain on both Macs;
- [ ] inspect deployed Vercel logs to confirm no infrastructure body logging is enabled;
- [ ] verify Neon credentials and VAPID private key exist only as encrypted environment variables;
- [ ] run malformed signature, replay, revoked-host and expired-subscription tests against staging;
- [ ] verify no prompt, response, path or command appears in Relay, Push or lock-screen output during ten real Remote turns.
