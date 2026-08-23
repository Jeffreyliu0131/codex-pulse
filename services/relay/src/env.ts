import type { RelayConfig } from "./types.ts";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function minimum(name: string, value: string, length: number): string {
  if (value.length < length || /^replace-with-/i.test(value)) {
    throw new Error(`${name} must contain at least ${length} characters`);
  }
  return value;
}

function decodedBase64url(name: string, value: string, bytes: number): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`${name} must be unpadded base64url`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== bytes || decoded.toString("base64url") !== value) {
    throw new Error(`${name} must be a base64url encoded ${bytes}-byte key`);
  }
  return decoded;
}

function vapidPublicKey(value: string): string {
  const decoded = decodedBase64url("VAPID_PUBLIC_KEY", value, 65);
  if (decoded[0] !== 4) throw new Error("VAPID_PUBLIC_KEY must be an uncompressed P-256 public key");
  return value;
}

function exactAppOrigin(value: string): string {
  const normalized = value.endsWith("/") ? value.slice(0, -1) : value;
  const parsed = new URL(normalized);
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (
    (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    normalized !== parsed.origin ||
    normalized === "https://codexpulse.example.vercel.app"
  ) {
    throw new Error("APP_ORIGIN must be an exact HTTPS origin without credentials, path, query, or fragment");
  }
  return parsed.origin;
}

function vapidSubject(value: string): string {
  const parsed = new URL(value);
  const validMail = parsed.protocol === "mailto:" && parsed.pathname.includes("@");
  const validHttps = parsed.protocol === "https:" && !parsed.username && !parsed.password;
  if ((!validMail && !validHttps) || value === "mailto:owner@example.com") {
    throw new Error("VAPID_SUBJECT must be an owner-controlled mailto: address or HTTPS URL");
  }
  return value;
}

function databaseUrl(value: string): string {
  const parsed = new URL(value);
  if (
    (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
    parsed.hostname === "host" ||
    parsed.username === "user"
  ) {
    throw new Error("DATABASE_URL must be a PostgreSQL connection URL");
  }
  return value;
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

let cached: RelayConfig | null = null;

export function loadConfig(): RelayConfig {
  if (cached) return cached;

  const nodeEnv = process.env.NODE_ENV === "production"
    ? "production"
    : process.env.NODE_ENV === "test"
      ? "test"
      : "development";
  const appOrigin = exactAppOrigin(required("APP_ORIGIN"));
  const accessToken = minimum("PULSE_ACCESS_TOKEN", required("PULSE_ACCESS_TOKEN"), 32);
  const sessionSecret = minimum("SESSION_SECRET", required("SESSION_SECRET"), 32);
  const masterKeyValue = required("RELAY_MASTER_KEY");
  const cronSecretRaw = process.env.CRON_SECRET?.trim() || null;
  const cronSecret = cronSecretRaw ? minimum("CRON_SECRET", cronSecretRaw, 32) : null;
  if (nodeEnv === "production" && !cronSecret) {
    throw new Error("CRON_SECRET is required in production");
  }
  const secretValues = [accessToken, sessionSecret, masterKeyValue, cronSecret].filter(Boolean);
  if (new Set(secretValues).size !== secretValues.length) {
    throw new Error("Access, session, master, and cron secrets must be generated independently");
  }

  cached = {
    appOrigin,
    accessToken,
    sessionSecret,
    masterKey: decodedBase64url("RELAY_MASTER_KEY", masterKeyValue, 32),
    vapidPublicKey: vapidPublicKey(required("VAPID_PUBLIC_KEY")),
    vapidPrivateKey: decodedBase64url("VAPID_PRIVATE_KEY", required("VAPID_PRIVATE_KEY"), 32).toString("base64url"),
    vapidSubject: vapidSubject(required("VAPID_SUBJECT")),
    cronSecret,
    databaseUrl: databaseUrl(required("DATABASE_URL")),
    nodeEnv,
    limits: {
      hosts: Math.min(2, positiveInteger("PULSE_MAX_HOSTS", 2)),
      subscriptions: Math.min(3, positiveInteger("PULSE_MAX_SUBSCRIPTIONS", 3)),
      tasks: Math.min(200, positiveInteger("PULSE_MAX_TASKS", 200)),
      events: Math.min(10_000, positiveInteger("PULSE_MAX_EVENTS", 10_000)),
      retentionDays: Math.min(7, positiveInteger("PULSE_RETENTION_DAYS", 7)),
    },
  };
  return cached;
}

export function resetConfigForTests(): void {
  cached = null;
}
