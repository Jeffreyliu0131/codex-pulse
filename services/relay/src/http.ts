import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  EventTypeSchema,
  HostHeartbeatSchema,
  IngestRequestSchema,
  PushSubscriptionRegistrationSchema,
  SnapshotBatchSchema,
  TaskPreferencesSchema,
} from "../../../packages/contracts/src/index.ts";
import {
  decryptString,
  encryptString,
  hmacBase64url,
  randomToken,
  safeEqual,
  sha256,
} from "./crypto.ts";
import { genericPushPayload, safeLabel, testPushPayload } from "./domain.ts";
import { authenticateHost } from "./host-auth.ts";
import { PushService } from "./push.ts";
import {
  clearSessionCookie,
  cookieValue,
  createSession,
  SESSION_COOKIE,
  sessionCookie,
  verifySession,
} from "./session.ts";
import type { RelayConfig, RelayStore } from "./types.ts";

const LoginSchema = z.object({ token: z.string().min(1).max(512) }).strict();
const ClaimPairingSchema = z
  .object({ code: z.string().regex(/^\d{8}$/), label: z.string().trim().min(1).max(64) })
  .strict();
const SubscriptionDeleteSchema = z.object({
  endpoint: z.string().url().max(2048).optional(),
  id: z.string().uuid().optional(),
}).strict().refine((value) => Boolean(value.endpoint || value.id), {
  message: "Subscription endpoint or registration ID is required",
});
const TaskPatchSchema = TaskPreferencesSchema.extend({
  notifyOn: z.array(EventTypeSchema).max(EventTypeSchema.options.length),
}).strict();
const EventReadSchema = z.object({ source: z.enum(["notification", "task"]) }).strict();

class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(
    status: number,
    code: string,
    message: string,
  ) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function routeMatch(pathname: string, pattern: RegExp): RegExpMatchArray | null {
  return pathname.match(pattern);
}

async function bodyText(request: Request, maxBytes = 64 * 1024): Promise<string> {
  const length = Number.parseInt(request.headers.get("content-length") ?? "0", 10);
  if (Number.isFinite(length) && length > maxBytes) {
    throw new ApiError(413, "body_too_large", "Request body is too large");
  }
  const body = await request.text();
  if (Buffer.byteLength(body, "utf8") > maxBytes) {
    throw new ApiError(413, "body_too_large", "Request body is too large");
  }
  return body;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError(400, "invalid_json", "Request body must be valid JSON");
  }
}

function isMutation(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method);
}

function requireBrowserOrigin(request: Request, config: RelayConfig): void {
  if (!isMutation(request.method)) return;
  const origin = request.headers.get("origin");
  if (origin !== config.appOrigin) {
    throw new ApiError(403, "origin_rejected", "Request origin is not allowed");
  }
}

function requireOwner(request: Request, config: RelayConfig, now: Date): void {
  const token = cookieValue(request.headers.get("cookie"), SESSION_COOKIE);
  if (!verifySession(token, config.sessionSecret, now)) {
    throw new ApiError(401, "authentication_required", "Sign in is required");
  }
}

function requestFingerprint(request: Request, config: RelayConfig): string {
  const address = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const agent = request.headers.get("user-agent")?.slice(0, 160) ?? "unknown";
  return sha256(hmacBase64url(config.masterKey, `${address}\n${agent}`));
}

function makePairingCode(): string {
  const value = Buffer.from(randomToken(8), "base64url").readBigUInt64BE();
  return (value % 100_000_000n).toString().padStart(8, "0");
}

function requirePlausibleTimes(input: {
  observedAt: string;
  sourceUpdatedAt?: string;
  occurredAt?: string;
}, now: Date): void {
  const maximum = now.getTime() + 5 * 60 * 1000;
  const observedAt = Date.parse(input.observedAt);
  const sourceUpdatedAt = input.sourceUpdatedAt == null ? null : Date.parse(input.sourceUpdatedAt);
  const occurredAt = input.occurredAt == null ? null : Date.parse(input.occurredAt);
  if (
    observedAt > maximum ||
    (sourceUpdatedAt != null && (sourceUpdatedAt > maximum || sourceUpdatedAt > observedAt + 5 * 60 * 1000)) ||
    (occurredAt != null && (occurredAt > maximum || occurredAt > observedAt + 5 * 60 * 1000))
  ) {
    throw new ApiError(400, "invalid_event_time", "Source timestamps are not plausible");
  }
}

export function createRelayHandler(input: {
  store: RelayStore;
  config: RelayConfig;
  push?: PushService;
  now?: () => Date;
}): (request: Request) => Promise<Response> {
  const nowProvider = input.now ?? (() => new Date());
  const push = input.push ?? new PushService(input.store, input.config);

  return async (request: Request): Promise<Response> => {
    const requestId = randomUUID();
    const now = nowProvider();
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "") || "/";

    try {
      if (request.method === "OPTIONS") return new Response(null, { status: 204 });

      if (request.method === "GET" && path === "/api/health") {
        try {
          await input.store.ping();
          return json({ ok: true, serverTime: now.toISOString() });
        } catch {
          return json({ ok: false, error: "storage_unavailable" }, 503);
        }
      }

      if (request.method === "GET" && path === "/api/config") {
        return json({
          schemaVersion: 1,
          vapidPublicKey: input.config.vapidPublicKey,
          appOrigin: input.config.appOrigin,
          limits: input.config.limits,
        });
      }

      if (request.method === "POST" && path === "/api/session") {
        requireBrowserOrigin(request, input.config);
        const attempts = await input.store.recordRateLimitAttempt(
          "login",
          requestFingerprint(request, input.config),
          now,
        );
        if (attempts > 10) throw new ApiError(429, "rate_limited", "Try again later");
        const parsed = LoginSchema.safeParse(parseJson(await bodyText(request, 2048)));
        if (!parsed.success || !safeEqual(parsed.data.token, input.config.accessToken)) {
          throw new ApiError(401, "invalid_credentials", "Access token is not valid");
        }
        const token = createSession(input.config.sessionSecret, now);
        return json(
          { ok: true },
          200,
          { "set-cookie": sessionCookie(token, input.config.appOrigin.startsWith("https://")) },
        );
      }

      if (request.method === "DELETE" && path === "/api/session") {
        requireBrowserOrigin(request, input.config);
        return json(
          { ok: true },
          200,
          { "set-cookie": clearSessionCookie(input.config.appOrigin.startsWith("https://")) },
        );
      }

      if (request.method === "GET" && path === "/api/me") {
        requireOwner(request, input.config, now);
        return json({ authenticated: true });
      }

      if (request.method === "GET" && path === "/api/dashboard") {
        requireOwner(request, input.config, now);
        return json(await input.store.dashboard(now, input.config.limits));
      }

      if (request.method === "POST" && path === "/api/pairings") {
        requireBrowserOrigin(request, input.config);
        requireOwner(request, input.config, now);
        const id = randomUUID();
        const code = makePairingCode();
        const expiresAt = new Date(now.getTime() + 5 * 60 * 1000);
        await input.store.createPairing({ id, codeHash: sha256(code), expiresAt, now });
        return json({ id, code, expiresAt: expiresAt.toISOString() }, 201);
      }

      if (request.method === "POST" && path === "/api/pairings/claim") {
        const attempts = await input.store.recordRateLimitAttempt(
          "pairing_claim",
          requestFingerprint(request, input.config),
          now,
        );
        if (attempts > 20) throw new ApiError(429, "rate_limited", "Try again later");
        const parsed = ClaimPairingSchema.safeParse(parseJson(await bodyText(request, 4096)));
        if (!parsed.success) throw new ApiError(400, "invalid_pairing_claim", "Invalid pairing claim");
        const hostId = randomUUID();
        const hostSecret = randomToken(32);
        const claimToken = randomToken(32);
        const result = await input.store.claimPairing({
          codeHash: sha256(parsed.data.code),
          hostId,
          hostLabel: safeLabel(parsed.data.label, "Mac"),
          secretCiphertext: encryptString(hostSecret, input.config.masterKey),
          claimTokenHash: sha256(claimToken),
          now,
        });
        if (!result) throw new ApiError(404, "pairing_not_found", "Pairing code is invalid or expired");
        return json(
          { pairingId: result.id, claimToken, status: "pending", expiresAt: result.expiresAt },
          202,
        );
      }

      if (request.method === "GET" && path === "/api/pairings/claim") {
        const claimToken = request.headers.get("x-pulse-claim-token")?.trim() ?? "";
        if (!/^[A-Za-z0-9_-]{32,128}$/.test(claimToken)) {
          throw new ApiError(400, "invalid_claim_token", "Pairing claim token is invalid");
        }
        const claim = await input.store.getPairingClaim(sha256(claimToken), now);
        if (!claim) throw new ApiError(404, "claim_not_found", "Pairing claim is invalid or expired");
        if (claim.status === "claimed") return json({ status: "pending" }, 202);
        if (claim.status !== "approved" && claim.status !== "consumed") {
          throw new ApiError(410, "claim_unavailable", "Pairing claim is no longer available");
        }
        if (
          claim.credentialDeliveredAt &&
          Date.parse(claim.credentialDeliveredAt) + 2 * 60 * 1000 < now.getTime()
        ) {
          throw new ApiError(410, "credential_already_delivered", "Pairing credential was already delivered");
        }
        const secret = decryptString(claim.secretCiphertext, input.config.masterKey);
        await input.store.markCredentialDelivered(claim.pairingId, now);
        return json({
          status: "approved",
          hostId: claim.hostId,
          hostLabel: claim.hostLabel,
          hostSecret: secret,
          relayUrl: input.config.appOrigin,
        });
      }

      const approveMatch = routeMatch(path, /^\/api\/pairings\/([0-9a-f-]{36})\/approve$/i);
      if (request.method === "POST" && approveMatch?.[1]) {
        requireBrowserOrigin(request, input.config);
        requireOwner(request, input.config, now);
        const approved = await input.store.approvePairing(
          approveMatch[1],
          now,
          input.config.limits.hosts,
        );
        if (!approved) throw new ApiError(409, "pairing_not_approved", "Pairing expired or host limit reached");
        return json({ ok: true });
      }

      const rejectMatch = routeMatch(path, /^\/api\/pairings\/([0-9a-f-]{36})\/reject$/i);
      if (request.method === "POST" && rejectMatch?.[1]) {
        requireBrowserOrigin(request, input.config);
        requireOwner(request, input.config, now);
        const rejected = await input.store.rejectPairing(rejectMatch[1], now);
        if (!rejected) throw new ApiError(404, "pairing_not_found", "Pairing was not found");
        return json({ ok: true });
      }

      if (request.method === "POST" && path === "/api/bridge/events") {
        const rawBody = await bodyText(request, 64 * 1024);
        const host = await authenticateHost({
          request,
          rawBody,
          store: input.store,
          config: input.config,
          now,
        });
        if (!host) throw new ApiError(401, "invalid_host_signature", "Host authentication failed");
        const parsed = IngestRequestSchema.safeParse(parseJson(rawBody));
        if (!parsed.success) throw new ApiError(400, "invalid_event", "Event contract validation failed");
        requirePlausibleTimes({
          observedAt: parsed.data.event.observedAt,
          occurredAt: parsed.data.event.occurredAt,
          sourceUpdatedAt: parsed.data.snapshot.sourceUpdatedAt,
        }, now);
        let result;
        try {
          result = await input.store.ingest(
            host.id,
            parsed.data,
            now,
            input.config.limits.tasks,
            input.config.limits.events,
          );
        } catch (error) {
          if ((error as Error).message === "FREE_TIER_TASK_LIMIT") {
            throw new ApiError(507, "free_tier_task_limit", "Task limit reached; cleanup is required");
          }
          if ((error as Error).message === "FREE_TIER_EVENT_LIMIT") {
            throw new ApiError(507, "free_tier_event_limit", "Event limit reached; cleanup is required");
          }
          throw error;
        }
        if (result.shouldNotify) {
          const delivery = await push.send(
            genericPushPayload({
              eventId: result.event.eventId,
              eventType: result.event.type,
              taskId: result.taskId,
              hostLabel: result.hostLabel,
              taskAlias: result.taskAlias,
              appOrigin: input.config.appOrigin,
            }),
            now,
          );
          if (delivery.delivered === 0 && delivery.failed > 0) {
            throw new ApiError(503, "push_transient_failure", "Push provider did not accept the notification");
          }
        }
        return json({
          accepted: result.accepted,
          duplicate: result.duplicate,
          taskId: result.taskId,
          acknowledgedSequence: result.event.sequence,
        });
      }

      if (request.method === "POST" && path === "/api/bridge/snapshots") {
        const rawBody = await bodyText(request, 96 * 1024);
        const host = await authenticateHost({
          request,
          rawBody,
          store: input.store,
          config: input.config,
          now,
        });
        if (!host) throw new ApiError(401, "invalid_host_signature", "Host authentication failed");
        const parsed = SnapshotBatchSchema.safeParse(parseJson(rawBody));
        if (!parsed.success) throw new ApiError(400, "invalid_snapshots", "Snapshot contract validation failed");
        for (const snapshot of parsed.data.snapshots) {
          requirePlausibleTimes({
            observedAt: snapshot.observedAt,
            sourceUpdatedAt: snapshot.sourceUpdatedAt,
          }, now);
        }
        let accepted: number;
        try {
          accepted = await input.store.upsertSnapshots(
            host.id,
            parsed.data,
            now,
            input.config.limits.tasks,
          );
        } catch (error) {
          if ((error as Error).message === "FREE_TIER_TASK_LIMIT") {
            throw new ApiError(507, "free_tier_task_limit", "Task limit reached; cleanup is required");
          }
          throw error;
        }
        return json({ accepted });
      }

      if (request.method === "POST" && path === "/api/bridge/heartbeat") {
        const rawBody = await bodyText(request, 32 * 1024);
        const host = await authenticateHost({
          request,
          rawBody,
          store: input.store,
          config: input.config,
          now,
        });
        if (!host) throw new ApiError(401, "invalid_host_signature", "Host authentication failed");
        const parsed = HostHeartbeatSchema.safeParse(parseJson(rawBody));
        if (!parsed.success) throw new ApiError(400, "invalid_heartbeat", "Heartbeat validation failed");
        await input.store.updateHeartbeat(host.id, parsed.data, now);
        return json({ accepted: true });
      }

      const revokeMatch = routeMatch(path, /^\/api\/hosts\/([0-9a-f-]{36})\/revoke$/i);
      if (request.method === "POST" && revokeMatch?.[1]) {
        requireBrowserOrigin(request, input.config);
        requireOwner(request, input.config, now);
        const revoked = await input.store.revokeHost(revokeMatch[1], now);
        if (!revoked) throw new ApiError(404, "host_not_found", "Host was not found");
        return json({ ok: true });
      }

      if (request.method === "POST" && path === "/api/push/subscriptions") {
        requireBrowserOrigin(request, input.config);
        requireOwner(request, input.config, now);
        const parsed = PushSubscriptionRegistrationSchema.safeParse(
          parseJson(await bodyText(request, 16 * 1024)),
        );
        if (!parsed.success) throw new ApiError(400, "invalid_subscription", "Push subscription is invalid");
        try {
          const result = await input.store.registerPushSubscription({
            id: randomUUID(),
            endpointHash: sha256(parsed.data.endpoint),
            payloadCiphertext: encryptString(JSON.stringify(parsed.data), input.config.masterKey),
            now,
            maxSubscriptions: input.config.limits.subscriptions,
          });
          return json(result, result.created ? 201 : 200);
        } catch (error) {
          if ((error as Error).message === "FREE_TIER_SUBSCRIPTION_LIMIT") {
            throw new ApiError(507, "free_tier_subscription_limit", "Phone subscription limit reached");
          }
          throw error;
        }
      }

      if (request.method === "DELETE" && path === "/api/push/subscriptions") {
        requireBrowserOrigin(request, input.config);
        requireOwner(request, input.config, now);
        const parsed = SubscriptionDeleteSchema.safeParse(parseJson(await bodyText(request, 4096)));
        if (!parsed.success) throw new ApiError(400, "invalid_subscription", "Push endpoint is invalid");
        const removedById = parsed.data.id
          ? await input.store.removePushSubscriptionById(parsed.data.id, now)
          : false;
        const removedByEndpoint = parsed.data.endpoint
          ? await input.store.removePushSubscription(sha256(parsed.data.endpoint), now)
          : false;
        const removed = removedById || removedByEndpoint;
        return json({ removed });
      }

      if (request.method === "POST" && path === "/api/push/test") {
        requireBrowserOrigin(request, input.config);
        requireOwner(request, input.config, now);
        return json(await push.send(testPushPayload(input.config.appOrigin), now));
      }

      const taskMatch = routeMatch(path, /^\/api\/tasks\/([0-9a-f-]{36})$/i);
      if (request.method === "PATCH" && taskMatch?.[1]) {
        requireBrowserOrigin(request, input.config);
        requireOwner(request, input.config, now);
        const parsed = TaskPatchSchema.safeParse(parseJson(await bodyText(request, 4096)));
        if (!parsed.success) throw new ApiError(400, "invalid_preferences", "Task preferences are invalid");
        const updated = await input.store.updateTaskPreferences({
          taskId: taskMatch[1],
          alias: parsed.data.alias ? safeLabel(parsed.data.alias, "") || null : null,
          muted: parsed.data.muted,
          notifyOn: [...new Set(parsed.data.notifyOn)],
          now,
        });
        if (!updated) throw new ApiError(404, "task_not_found", "Task was not found");
        return json({ ok: true });
      }

      const eventMatch = routeMatch(path, /^\/api\/events\/(evt_[A-Za-z0-9_-]{24,96})\/read$/);
      if (request.method === "POST" && eventMatch?.[1]) {
        requireBrowserOrigin(request, input.config);
        requireOwner(request, input.config, now);
        const parsed = EventReadSchema.safeParse(parseJson(await bodyText(request, 1024)));
        if (!parsed.success) throw new ApiError(400, "invalid_read_source", "Event read source is invalid");
        const updated = await input.store.markEventRead(
          eventMatch[1],
          now,
          parsed.data.source === "notification",
        );
        if (!updated) throw new ApiError(404, "event_not_found", "Event was not found");
        return json({ ok: true });
      }

      if ((request.method === "POST" || request.method === "GET") && path === "/api/admin/cleanup") {
        const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
        const isCron = Boolean(input.config.cronSecret && safeEqual(bearer, input.config.cronSecret));
        if (request.method === "GET" && !isCron) {
          throw new ApiError(401, "cron_authentication_required", "Cron authentication is required");
        }
        if (!isCron) {
          requireBrowserOrigin(request, input.config);
          requireOwner(request, input.config, now);
        }
        return json(await input.store.cleanup(now, input.config.limits));
      }

      throw new ApiError(404, "not_found", "API route was not found");
    } catch (error) {
      if (error instanceof ApiError) {
        return json(
          { error: error.code, message: error.message, requestId },
          error.status,
          { "x-request-id": requestId },
        );
      }
      return json(
        { error: "internal_error", message: "The Relay could not complete the request", requestId },
        500,
        { "x-request-id": requestId },
      );
    }
  };
}
