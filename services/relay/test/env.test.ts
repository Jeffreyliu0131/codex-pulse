import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig, resetConfigForTests } from "../src/env.ts";

const managedNames = [
  "APP_ORIGIN",
  "PULSE_ACCESS_TOKEN",
  "SESSION_SECRET",
  "RELAY_MASTER_KEY",
  "CRON_SECRET",
  "DATABASE_URL",
  "VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
  "VAPID_SUBJECT",
  "NODE_ENV",
] as const;

test("production config accepts only canonical origins and independent key material", () => {
  const previous = Object.fromEntries(managedNames.map((name) => [name, process.env[name]]));
  try {
    Object.assign(process.env, {
      APP_ORIGIN: "https://pulse.example",
      PULSE_ACCESS_TOKEN: "a".repeat(32),
      SESSION_SECRET: "b".repeat(32),
      RELAY_MASTER_KEY: Buffer.alloc(32, 3).toString("base64url"),
      CRON_SECRET: "d".repeat(32),
      DATABASE_URL: "postgresql://owner:secret@db.example/pulse?sslmode=require",
      VAPID_PUBLIC_KEY: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 5)]).toString("base64url"),
      VAPID_PRIVATE_KEY: Buffer.alloc(32, 6).toString("base64url"),
      VAPID_SUBJECT: "mailto:security@pulse.test",
      NODE_ENV: "production",
    });
    resetConfigForTests();
    const config = loadConfig();
    assert.equal(config.appOrigin, "https://pulse.example");
    assert.equal(config.masterKey.length, 32);

    process.env.APP_ORIGIN = "https://pulse.example/subpath";
    resetConfigForTests();
    assert.throws(() => loadConfig(), /exact HTTPS origin/);

    process.env.APP_ORIGIN = "https://pulse.example";
    process.env.SESSION_SECRET = process.env.PULSE_ACCESS_TOKEN;
    resetConfigForTests();
    assert.throws(() => loadConfig(), /generated independently/);
  } finally {
    for (const name of managedNames) {
      const value = previous[name];
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
    resetConfigForTests();
  }
});
