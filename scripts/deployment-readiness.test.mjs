import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

function run(env) {
  return spawnSync(process.execPath, ["--experimental-strip-types", "scripts/deployment-readiness.mjs"], {
    encoding: "utf8", env,
  });
}

test("readiness needs no private file and fails closed with missing environment", () => {
  const result = run({});
  assert.equal(result.status, 2);
  assert.match(result.stdout, /missing: DATABASE_URL/);
  assert.match(result.stdout, /No files containing secrets were read/);
});

test("readiness hides malformed values and does not load ambient credentials", () => {
  const marker = "synthetic-private-value-do-not-print";
  const names = ["APP_ORIGIN", "PULSE_ACCESS_TOKEN", "SESSION_SECRET", "RELAY_MASTER_KEY", "CRON_SECRET", "DATABASE_URL", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"];
  const result = run(Object.fromEntries(names.map(name => [name, marker])));
  assert.equal(result.status, 2);
  assert.match(result.stdout, /configuration is invalid/);
  assert.ok(!(result.stdout + result.stderr).includes(marker));
});

test("readiness validates synthetic production formats without contacting services", () => {
  const result = run({
    APP_ORIGIN: "https://pulse.synthetic-fixture.net",
    PULSE_ACCESS_TOKEN: "a".repeat(32), SESSION_SECRET: "b".repeat(32),
    RELAY_MASTER_KEY: Buffer.alloc(32, 3).toString("base64url"), CRON_SECRET: "d".repeat(32),
    DATABASE_URL: "postgresql://fixture:fake@db.example/pulse",
    VAPID_PUBLIC_KEY: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 5)]).toString("base64url"),
    VAPID_PRIVATE_KEY: Buffer.alloc(32, 6).toString("base64url"), VAPID_SUBJECT: "mailto:fixture@pulse.test",
  });
  assert.match(result.stdout, /ready: production configuration format/);
  assert.ok([0, 2].includes(result.status)); // artifact presence depends on local builds
  assert.doesNotMatch(result.stdout, /configuration is invalid/);
});
