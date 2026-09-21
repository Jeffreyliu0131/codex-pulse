import type { RelayConfig } from "./types.ts";

type Environment = Readonly<Record<string, string | undefined>>;

function required(env: Environment, name: string): string {
  const value = env[name]?.trim();
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

function parsedURL(name: string, value: string): URL {
  try { return new URL(value); } catch {
    // URL errors may include credentials in their input; never propagate them.
    throw new Error(`${name} must be a valid URL`);
  }
}

function placeholderHost(hostname: string): boolean {
  return /(?:^|\.)(?:example(?:\.(?:com|net|org))?|test|invalid|localhost)(?:\.|$)/i.test(hostname) ||
    /^your[-.]/i.test(hostname);
}

function exactAppOrigin(value: string, production: boolean): string {
  const normalized = value.endsWith("/") ? value.slice(0, -1) : value;
  const parsed = parsedURL("APP_ORIGIN", normalized);
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (
    (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    normalized !== parsed.origin ||
    normalized === "https://codexpulse.example.vercel.app" ||
    (production && (parsed.protocol !== "https:" || local || placeholderHost(parsed.hostname)))
  ) {
    throw new Error("APP_ORIGIN must be an exact HTTPS origin without credentials, path, query, or fragment");
  }
  return parsed.origin;
}

function vapidSubject(value: string): string {
  const parsed = parsedURL("VAPID_SUBJECT", value);
  const validMail = parsed.protocol === "mailto:" && parsed.pathname.includes("@");
  const validHttps = parsed.protocol === "https:" && !parsed.username && !parsed.password;
  if ((!validMail && !validHttps) || value === "mailto:owner@example.com") {
    throw new Error("VAPID_SUBJECT must be an owner-controlled mailto: address or HTTPS URL");
  }
  return value;
}

function databaseUrl(value: string): string {
  const parsed = parsedURL("DATABASE_URL", value);
  if (
    (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
    !parsed.hostname || parsed.pathname.length <= 1 ||
    parsed.hostname === "host" ||
    parsed.username === "user"
  ) {
    throw new Error("DATABASE_URL must be a PostgreSQL connection URL");
  }
  return value;
}

function positiveInteger(env: Environment, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

let cached: RelayConfig | null = null;

export function validateConfig(env: Environment): RelayConfig {
  const nodeEnv = env.NODE_ENV === "production"
    ? "production"
    : env.NODE_ENV === "test"
      ? "test"
      : "development";
  const appOrigin = exactAppOrigin(required(env, "APP_ORIGIN"), nodeEnv === "production");
  const accessToken = minimum("PULSE_ACCESS_TOKEN", required(env, "PULSE_ACCESS_TOKEN"), 32);
  const sessionSecret = minimum("SESSION_SECRET", required(env, "SESSION_SECRET"), 32);
  const masterKeyValue = required(env, "RELAY_MASTER_KEY");
  const cronSecretRaw = env.CRON_SECRET?.trim() || null;
  const cronSecret = cronSecretRaw ? minimum("CRON_SECRET", cronSecretRaw, 32) : null;
  if (nodeEnv === "production" && !cronSecret) {
    throw new Error("CRON_SECRET is required in production");
  }
  const secretValues = [accessToken, sessionSecret, masterKeyValue, cronSecret].filter(Boolean);
  if (new Set(secretValues).size !== secretValues.length) {
    throw new Error("Access, session, master, and cron secrets must be generated independently");
  }

  return {
    appOrigin,
    accessToken,
    sessionSecret,
    masterKey: decodedBase64url("RELAY_MASTER_KEY", masterKeyValue, 32),
    vapidPublicKey: vapidPublicKey(required(env, "VAPID_PUBLIC_KEY")),
    vapidPrivateKey: decodedBase64url("VAPID_PRIVATE_KEY", required(env, "VAPID_PRIVATE_KEY"), 32).toString("base64url"),
    vapidSubject: vapidSubject(required(env, "VAPID_SUBJECT")),
    cronSecret,
    databaseUrl: databaseUrl(required(env, "DATABASE_URL")),
    nodeEnv,
    limits: {
      hosts: Math.min(2, positiveInteger(env, "PULSE_MAX_HOSTS", 2)),
      subscriptions: Math.min(3, positiveInteger(env, "PULSE_MAX_SUBSCRIPTIONS", 3)),
      tasks: Math.min(200, positiveInteger(env, "PULSE_MAX_TASKS", 200)),
      events: Math.min(10_000, positiveInteger(env, "PULSE_MAX_EVENTS", 10_000)),
      retentionDays: Math.min(7, positiveInteger(env, "PULSE_RETENTION_DAYS", 7)),
    },
  };
}

export function loadConfig(): RelayConfig {
  return cached ??= validateConfig(process.env);
}

export function resetConfigForTests(): void {
  cached = null;
}
