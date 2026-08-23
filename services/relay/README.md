# CodexPulse Relay

Node.js Relay for Vercel Functions with Neon Postgres durability.

Implemented responsibilities:

- single-owner token login and signed browser session;
- five-minute, single-use pairing with phone confirmation;
- encrypted per-host and Push secrets;
- timestamped, nonce-protected, body-bound HMAC ingestion;
- strict contract validation, idempotent events and revision-ordered task projection;
- per-task watch rules and generic Declarative Web Push;
- heartbeats, host/phone revocation, unread state, retention and audit-safe events;
- Hobby-compatible daily cleanup plus manual owner cleanup.

No endpoint accepts prompts, approvals, commands, diffs, transcript content or ChatGPT credentials.

## Local setup

Copy `.env.example` to an untracked `.env`, supply a Postgres URL and generated secrets, then:

```sh
npm run db:migrate
npm run dev
```

The dev server binds localhost. Production uses `api/index.ts` as a thin Vercel adapter around the same Fetch `Request → Response` handler.

## Limits

Environment overrides may only lower the accepted caps: two hosts, three subscriptions, 200 tasks, 10,000 events and seven days. The Relay returns an explicit quota error rather than enabling a paid service.

## Verification

```sh
npm run typecheck --workspace @codexpulse/relay
npm run test --workspace @codexpulse/relay
```

Database migrations use only standard Postgres SQL. A real Neon integration and Vercel runtime smoke test are required after deployment.
