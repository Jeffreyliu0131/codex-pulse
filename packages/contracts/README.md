# CodexPulse Contracts

Strict Zod schemas and TypeScript types shared by PWA and Relay; the Swift Bridge mirrors their JSON representation.

Version 1 includes:

- `TaskSnapshot` and `TaskEvent`;
- `IngestRequest`;
- `HostHeartbeat` and source health;
- `TaskPreferences`;
- `PushSubscriptionRegistration`;
- `SafePushPayload` using Declarative Web Push version 8030.

Opaque identifiers must be prefixed `tsk_` or `evt_`, timestamps include an offset, unknown fields are rejected, and raw content fields cannot pass strict validation. Push contains only generic copy, user-approved safe labels, opaque IDs and same-application routing data.

```sh
npm run typecheck --workspace @codexpulse/contracts
npm run test --workspace @codexpulse/contracts
```
