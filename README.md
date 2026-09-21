# CodexPulse

CodexPulse is a read-only, notification-first companion for long-running Codex tasks. A small macOS bridge observes task state on the machine where work is happening, sends a minimal signed event to a relay, and lets an iPhone PWA notify the user when attention is needed.

The project explores a concrete product problem: how to reduce manual status checking without exposing prompts, transcripts, repository paths, or remote-control capability.

## Ownership and evidence boundary

This is an independent personal project. I defined the notification-first product boundary, privacy threat model, data-minimization rules, pairing and revocation behavior, failure states, and acceptance criteria. AI coding agents supported implementation and review under my direction; I reviewed changes and verified the contracts, relay, PWA, and macOS bridge behavior.

The repository demonstrates a tested reference implementation. It does not claim production-scale reliability, external user adoption, or endorsement by OpenAI.

## Product boundaries

CodexPulse can represent:

- running;
- waiting for approval;
- waiting for user input;
- completed;
- failed;
- stale or unavailable source state.

The reference implementation is intentionally read-only. It cannot send prompts, approve commands, expose a shell, or synchronize full transcripts.

## Architecture

```text
macOS Bridge -- signed outbound HTTPS --> Relay --> Web Push --> iPhone PWA
      |                                      |
  local state                          minimal event store
```

- **macOS bridge:** Swift, local Codex adapters, Keychain credentials, HMAC signing, bounded offline queue.
- **Relay:** Node request handler, PostgreSQL storage, pairing, replay protection, Web Push.
- **PWA:** TypeScript and Vite, installable shell, task projection, watch rules, safe offline cache.
- **Contracts:** shared Zod schemas for snapshots, events, health, preferences, and push payloads.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/SECURITY.md](docs/SECURITY.md).

## Privacy model

- Raw conversation IDs are converted to host-keyed opaque identifiers.
- Titles, prompts, responses, commands, diffs, repository names, and absolute paths are not uploaded by default.
- Push notifications contain generic text and fetch detail only after authenticated app open.
- Each host has a separate revocable credential.
- Fixtures and previews use synthetic task data.

## Local verification

Node.js 22.x is required:

```bash
npm ci
npm run verify
npm run preview:ui
```

On macOS, the bridge can also be compiled and self-tested:

```bash
npm run bridge:build
npm run bridge:self-test
```

The relay requires operator-provided server-side environment values; see [`.env.example`](.env.example). No real credentials or user task data are included.

## Source consolidation

This repository is the single maintained code source for the bridge, relay and PWA. Future changes and deployment builds belong here; personal runtime configuration, credentials, real task records and historical development notes stay private. The former private repository is retained as historical evidence and recovery material, not a second feature-maintenance branch. Its history is not merged into this repository.

**Source status (2026-09-21):** the reviewed single-source consolidation, including the sharp security fix, was published to public main as `2c857f9a0ff0b3dafa52a691df1f53fda7a17fbe`. This repository is now the continuing code source. No cloud resources were created or changed and no active deployment is verified. The known historical preview URL returned 404 on recheck. Database, other hosting accounts, cron and installed bridges remain unknown and untouched. The old private repository still exists; its maintenance notice has not been pushed and it has not been archived or deleted. This is a source-consolidation change, not an end-to-end acceptance claim.

Comparison was made against public `c474256b0479f74159a741a406d9f4e6305d743f` and private `b2c4c4f97d3f55242f4c3c10b605194563624f7f`. Among 79 shared paths, 56 were identical and 23 differed; five files existed only in public and ten only in private. No private-only product runtime was found.

| Area | Resolution |
|---|---|
| Bridge daemon, CLI, credentials and state | Retain public binary fingerprints, noninteractive background Keychain access, duplicate-account refusal, and recovery metadata; no old credential overwrite behavior imported |
| Models / RelayClient | Retain public explicit nullable contract fields, HTTP 202 pairing support and signed API-path validation fixes |
| Notify config / install / uninstall | Retain public TOML-safe backup/rollback and refusal to overwrite paired unsigned binaries; replace unsafe legacy upgrade instructions |
| Relay HTTP / PostgreSQL | Retain public runtime-relative contract import and exclusion of revoked hosts, plus query-injection test seam; all other private relay behavior is present |
| PWA, contracts, migrations and remaining bridge logic | Identical across both baselines; preserve pairing, HMAC/replay defenses, bounded queues, snapshots, watch rules, generic Push and offline privacy behavior |
| Runtime/toolchain | Retain public Node 22.x, TypeScript 6.0.3, TS import rewriting, Vercel runtime test, deployment exclusions and default Function memory configuration; retain public dependency graph with the targeted sharp security patch |
| Private-only readiness script | Reimplement using the same pure validator as runtime; no implicit `.env` read, no network, no secret output; reject production placeholder/loopback origins and redact malformed URL errors |
| Private-only docs / agent guide | Keep internal plans, research, provenance and machine-specific history private; publish reviewed self-hosting/operations guidance here, without copying internal diaries or account details |

### Verification and remaining gates

Reproduction: `npm ci`, `npm run verify:all`, `npm run check:public`. `npm run readiness` is a separate optional deployment preflight and deliberately fails without operator configuration. Tests and preview use synthetic fixtures only. The boundary scan is heuristic and does not replace review of diffs, history and assets.

Validated on 2026-09-21 with Node 22.23.1, npm 10.9.8 and Apple Swift 6.4 (Command Line Tools):

- `npm ci` and `npm run verify`: typechecks, 38 tests (4 script/runtime, 5 PWA, 7 contracts, 22 relay) and Vite production build passed.
- `npm run bridge:build`, `npm run bridge:self-test`: debug build and 25 standalone checks passed. Release build (`swift build --disable-sandbox --package-path apps/macos-bridge -c release`) and its standalone self-test also passed. Release dSYM generation needed permission beyond the filesystem sandbox; no installer was run.
- `./node_modules/.bin/tsc -p tsconfig.json --noEmit false --outDir .build/relay`: relay/API JavaScript emission passed; emitted API import and `/api/config` were also exercised with synthetic configuration and network disabled. This is not a Vercel platform deployment test.
- `npm run check:public`, generated static-asset credential/path checks, edited Markdown file links and `git diff --check` passed.
- `swift test --disable-sandbox --package-path apps/macos-bridge`: blocked by missing `XCTest` in Command Line Tools; full Xcode is required. Standalone checks are not represented as the complete XCTest suite.
- `npm run readiness` without injected credentials: expected exit 2, nine missing variable names; no values read from files and no network activity.
- Targeted dependency repair: pin development-only `sharp` from 0.35.3 to **0.35.4**, the first patched version in [GHSA-rgj7-g3m4-5g8c](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c). Registry metadata requires Node >=20.9.0, compatible with this repo's Node 22.x. Only sharp and its matching platform packages/libvips changed in the lockfile; no unrelated dependency was upgraded. `npm ci --offline`, `npm run assets`, all 38 Node tests/typechecks, production build and `npm run check:public` passed after the repair. All four regenerated PNG icons are byte-identical to the committed versions. Full `npm audit` now reports **0 vulnerabilities** (2026-09-21). Swift sources were unchanged and the earlier Swift results stand; Swift was not rebuilt for this dependency-only follow-up.

Remaining external gates are an authorized real database/Function runtime check, local Keychain/notify installation acceptance, actual Codex transitions and locked-iPhone Web Push. These are not failed unit tests and are not required to publish a source-only consolidation.

The pre-publication check found the public remote still matched the reviewed baseline; GitHub reported no Actions workflows, repository webhooks, deployment records or check runs. There is no configured GitHub CI to label green; the verification above was run locally. No deployment was recreated. Any future runtime validation or private-repository retirement remains a separate action. See [source transition and rollback](docs/OPERATIONS.md#private-history-retirement--after-source-reviewpublication).

## Optional self-hosting

[Deployment guide](docs/DEPLOYMENT.md) separates local builds, bridge installation, relay/database configuration and PWA setup. [Operations](docs/OPERATIONS.md) covers diagnosis, key continuity, safe unsigned-binary upgrades and rollback. Public code does not require a public service. No deployment URL, project ID or private credential is embedded in the code.

## License

No open-source license is granted. The source is public for portfolio review and technical discussion; all rights are reserved.
