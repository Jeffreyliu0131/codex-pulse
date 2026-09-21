import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig, resetConfigForTests, validateConfig } from "../src/env.ts";

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
      APP_ORIGIN: "https://pulse.synthetic-fixture.net",
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
    assert.equal(config.appOrigin, "https://pulse.synthetic-fixture.net");
    assert.equal(config.masterKey.length, 32);

    process.env.APP_ORIGIN = "https://pulse.synthetic-fixture.net/subpath";
    resetConfigForTests();
    assert.throws(() => loadConfig(), /exact HTTPS origin/);

    process.env.APP_ORIGIN = "https://pulse.synthetic-fixture.net";
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

// Synthetic configuration: no server is contacted and no credentials are usable.
function fixture() {
  return {
    APP_ORIGIN: "https://pulse.synthetic-fixture.net",
    PULSE_ACCESS_TOKEN: "a".repeat(32), SESSION_SECRET: "b".repeat(32),
    RELAY_MASTER_KEY: Buffer.alloc(32, 3).toString("base64url"), CRON_SECRET: "d".repeat(32),
    DATABASE_URL: "postgresql://fixture:fake@db.example/pulse",
    VAPID_PUBLIC_KEY: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 5)]).toString("base64url"),
    VAPID_PRIVATE_KEY: Buffer.alloc(32, 6).toString("base64url"),
    VAPID_SUBJECT: "mailto:fixture@pulse.test", NODE_ENV: "production",
  };
}

test("production rejects local and placeholder origins; test/dev loopback stays usable", () => {
  for (const origin of ["http://127.0.0.1:8787", "https://localhost", "https://[::1]", "https://pulse.example", "https://example.com", "https://pulse.test", "https://YOUR-DOMAIN", "https://codexpulse.example.vercel.app"]) {
    assert.throws(() => validateConfig({ ...fixture(), APP_ORIGIN: origin }), /APP_ORIGIN/);
  }
  assert.equal(validateConfig({ ...fixture(), NODE_ENV: "test", APP_ORIGIN: "http://127.0.0.1:8787" }).appOrigin, "http://127.0.0.1:8787");
});

test("pure validation is isolated from cached runtime config and applies hard caps", () => {
  assert.equal(validateConfig({ ...fixture(), PULSE_MAX_HOSTS: "999" }).limits.hosts, 2);
  assert.equal(validateConfig({ ...fixture(), PULSE_MAX_HOSTS: "1" }).limits.hosts, 1);
  assert.throws(() => validateConfig({ ...fixture(), PULSE_MAX_EVENTS: "1.2" }), /positive integer/);
  assert.throws(() => validateConfig({ ...fixture(), CRON_SECRET: "" }), /CRON_SECRET/);
});

test("invalid URL errors never expose input and database requires host and database name", () => {
  const marker = "synthetic-sensitive-marker";
  for (const name of ["APP_ORIGIN", "DATABASE_URL", "VAPID_SUBJECT"]) {
    assert.throws(() => validateConfig({ ...fixture(), [name]: marker }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(name));
      assert.ok(!JSON.stringify(error).includes(marker));
      assert.ok(!error.message.includes(marker));
      return true;
    });
  }
  for (const url of ["postgresql:///pulse", "postgresql://db.example/"]) {
    assert.throws(() => validateConfig({ ...fixture(), DATABASE_URL: url }), /DATABASE_URL/);
  }
});
