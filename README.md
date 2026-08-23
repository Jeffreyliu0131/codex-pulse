# CodexPulse

CodexPulse is a read-only, notification-first companion for long-running Codex tasks. A small macOS bridge observes task state on the machine where work is happening, sends a minimal signed event to a relay, and lets an iPhone PWA notify the user when attention is needed.

The project explores a concrete product problem: how to reduce manual status checking without exposing prompts, transcripts, repository paths, or remote-control capability.

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

Node.js 22 or newer is required:

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

## Public-snapshot note

This is a clean public snapshot derived from the latest validated private branch. Personal deployment records, local machine paths, private project references, live credentials, and operational account metadata are intentionally excluded.

The original project used AI coding agents during implementation and review. The public snapshot preserves the product constraints, source, tests, and security model without carrying over the private development history.

## License

No open-source license is granted. The source is public for portfolio review and technical discussion; all rights are reserved.
