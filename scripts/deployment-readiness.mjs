import { access } from "node:fs/promises";
import { validateConfig } from "../services/relay/src/env.ts";

// Deliberately no dotenv, network, database, Keychain, or host-state access.
// An operator may explicitly inject an environment through their secret manager.
const names = [
  "APP_ORIGIN", "PULSE_ACCESS_TOKEN", "SESSION_SECRET", "RELAY_MASTER_KEY",
  "CRON_SECRET", "DATABASE_URL", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT",
];
let blockers = 0;
for (const name of names) {
  const present = Boolean(process.env[name]?.trim());
  console.log(`${present ? "present" : "missing"}: ${name}`);
  if (!present) blockers += 1;
}
if (blockers === 0) {
  try {
    // Use exactly the runtime validator, including production HTTPS requirements.
    validateConfig({ ...process.env, NODE_ENV: "production" });
    console.log("ready: production configuration format");
  } catch {
    // Do not print error messages/objects: future validators may include input.
    console.log("blocked: production configuration is invalid; check variable formats in docs/DEPLOYMENT.md");
    blockers += 1;
  }
}
for (const path of [
  "apps/pwa/dist/index.html",
  "apps/macos-bridge/.build/debug/codex-pulse-bridge",
  "services/relay/migrations/001_initial.sql",
  "services/relay/migrations/002_delivery_observability.sql",
]) {
  try {
    await access(new URL(`../${path}`, import.meta.url));
    console.log(`present: ${path}`);
  } catch {
    console.log(`missing: ${path}`);
    blockers += 1;
  }
}
console.log("This checks formats and artifact presence only, not database access, VAPID key pairing, deployment, or delivery.");
console.log("No files containing secrets were read; no network requests or pushes were sent.");
console.log(`Readiness: ${blockers === 0 ? "ready for separately authorized external checks" : `${blockers} blocker(s)`}.`);
process.exitCode = blockers === 0 ? 0 : 2;
