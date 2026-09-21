# Self-hosting CodexPulse

This repository is the single maintained source for the macOS bridge, relay and PWA. Self-hosting is optional; repository consolidation does not create, revive or migrate a service. No active hosted instance or real-device delivery is claimed. Current consolidation status and validation are in [README](../README.md#source-consolidation).

## Components and supported target

| Component | Build/runtime entry | Runtime data location |
|---|---|---|
| macOS bridge | Swift package; `scripts/install-bridge.sh` is an explicit local installation action | Per-host Keychain secret; private local queue/config/notify backup |
| Relay | `api/index.ts` → Fetch handler; Vercel Node Function | Operator-owned Neon Postgres; encrypted host secrets and Push subscriptions |
| PWA | `npm run build` → `apps/pwa/dist` | Same origin as relay; authenticated API; safe offline projection |

The supplied deployment adapter is Vercel + Neon. The SQL is PostgreSQL, but the current `PostgresStore` uses Neon's HTTP driver: a plain PostgreSQL server is **not** a tested drop-in runtime target. Another hosting/database target requires a separately reviewed adapter. Multiple targets may build the same source commit, with separate environments and data; do not maintain a second feature fork.

## Reproduce without credentials

Use Node **22.x**, npm and, for the bridge, macOS 14+ with a matching Swift compiler/SDK:

```sh
npm ci
npm run verify:all
npm run check:public
npm run preview:ui
```

The preview binds loopback and uses synthetic data. Tests use fixtures/mocks, not the installed bridge, Keychain, Codex config, real tasks, Neon or Web Push. Full Xcode is needed for the optional mirrored `swift test`; the standalone self-test runs with Command Line Tools. Build alone does not install the bridge.

## Server configuration

Use [`.env.example`](../.env.example) for **variable names and formats**, not deployable values. Keep real settings in the hosting platform's server environment/secret manager. Optional local `.env` files, `.vercel/` linkage, database backups and operator notes must stay ignored and private. Never put server secrets in `VITE_*`, static assets or screenshots.

| Variable | Requirement / recovery implication |
|---|---|
| `APP_ORIGIN` | Actual canonical HTTPS origin, no credentials/path/query/fragment. Production rejects loopback and example/test/placeholder hosts. Exact origin is used by browser mutation checks and notification URLs. |
| `PULSE_ACCESS_TOKEN` | At least 32 independently random characters; owner login only |
| `SESSION_SECRET` | Independently generated, at least 32 characters; rotation invalidates sessions |
| `RELAY_MASTER_KEY` | Exactly 32 random bytes encoded as unpadded base64url; needed to decrypt stored host/Push credentials |
| `CRON_SECRET` | Independently generated, at least 32 characters; required in production |
| `DATABASE_URL` | Neon PostgreSQL connection URL with a host and database name; server-only |
| `VAPID_PUBLIC_KEY` | 65-byte uncompressed P-256 public key, unpadded base64url |
| `VAPID_PRIVATE_KEY` | Matching 32-byte P-256 private key, unpadded base64url; server-only |
| `VAPID_SUBJECT` | Operator-controlled mailto or HTTPS contact |
| `PULSE_MAX_HOSTS`, `PULSE_MAX_SUBSCRIPTIONS`, `PULSE_MAX_TASKS`, `PULSE_MAX_EVENTS`, `PULSE_RETENTION_DAYS` | Positive integers; runtime clamps to 2 / 3 / 200 / 10000 / 7 respectively; lower limits are supported |

Generate independent secrets and a valid VAPID key pair using trusted local tools, save recovery material in an operator-controlled secret store, and do not paste values into chat or repository files. Format checks cannot prove randomness or that VAPID public/private keys match.

With values already injected in the process environment:

```sh
npm run readiness
```

This deliberately does **not** load `.env`, access the Keychain, call services or print values. Exit 2 means missing/invalid configuration or missing local artifacts; with no credentials it is expected. It shares validation with the relay, forces production rules, and checks artifact presence. Exit 0 is only readiness for external checks, not deployment or device acceptance. An operator choosing a local file may explicitly use `node --env-file=.env --experimental-strip-types scripts/deployment-readiness.mjs` in a private terminal.

## Optional deployment sequence — separately authorized

1. Inventory an existing target before creating anything: hosting project/account, Git source SHA, actual domain, database owner, schema, environment-variable **names**, cron, bridge versions, and subscriptions. Unknown does not mean absent. Verify provider plan, limits and costs at execution time; this repo does not guarantee a free tier.
2. Choose the public repository and reviewed commit as the sole source. Preserve the previous deployment artifact and its source SHA. Disable unintended auto-deploys before reconnecting an existing target. Keep any linkage IDs local in ignored `.vercel/` or platform settings.
3. Configure the real production origin and server variables. Do not deploy literal placeholders. Keep Preview environments isolated from production secrets, databases and Push subscriptions. Platform access protection must still allow explicitly authenticated bridge requests and Push navigation.
4. Back up an existing database privately. With the correct `DATABASE_URL` injected, run `npm run db:migrate`; this executes both sorted, idempotent SQL migrations. It is a database write, not part of source verification. Preserve `RELAY_MASTER_KEY` and VAPID keys when retaining encrypted records and subscriptions.
5. Configure Node 22.x, root directory at this repo, build command `npm run build`, output `apps/pwa/dist`; `vercel.json` supplies the API rewrite, security headers and daily cleanup route. The framework build does not prove Function packaging. Inspect the platform build output, then deploy only the reviewed commit. CLI linkage/deployment is an explicit operator action (`vercel link`, then `vercel --prod` using an approved CLI version).
6. Check `/api/health` (database reachability), `/api/config`, static assets, authenticated login, origin rejection, pairing and schema. A page HTTP 200 alone proves none of these. Inspect content-free infrastructure logs; disable request-body, authorization-header and query credential capture.
7. If installing a bridge is authorized, use [bridge instructions](../apps/macos-bridge/README.md). Install the final binary **before pairing**. A different unsigned binary requires revocation/reset with the old trusted binary and fresh pairing; never copy over a paired executable. Preserve the previous notify command and validated backup.
8. On an actual iPhone, install the HTTPS PWA through Safari → Add to Home Screen, then explicitly enable Push. Test a synthetic watched event only with user consent: even `test-event` can send a real notification. Record provider acceptance and visible lock-screen presentation separately.

A configured server/desktop deployment may remain private even though its code is public. Phone permission, Focus, background state, Mac sleep and actual Codex signals require real-device acceptance under the [PRD](PRD.md); they are not inferred from unit tests. See [operations](OPERATIONS.md) for safe upgrades and recovery.
