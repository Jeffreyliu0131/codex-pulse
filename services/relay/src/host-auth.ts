import type { RelayConfig, RelayStore } from "./types.ts";
import {
  canonicalHostRequest,
  decryptString,
  hmacBase64url,
  safeEqual,
  sha256,
} from "./crypto.ts";

const MAX_CLOCK_SKEW_SECONDS = 5 * 60;

export interface AuthenticatedHost {
  id: string;
  label: string;
}

export async function authenticateHost(input: {
  request: Request;
  rawBody: string;
  store: RelayStore;
  config: RelayConfig;
  now: Date;
}): Promise<AuthenticatedHost | null> {
  const hostId = input.request.headers.get("x-pulse-host-id")?.trim() ?? "";
  const timestamp = input.request.headers.get("x-pulse-timestamp")?.trim() ?? "";
  const nonce = input.request.headers.get("x-pulse-nonce")?.trim() ?? "";
  const suppliedBodyHash = input.request.headers.get("x-pulse-body-sha256")?.trim() ?? "";
  const signature = input.request.headers.get("x-pulse-signature")?.trim() ?? "";

  if (
    !/^[0-9a-f-]{36}$/i.test(hostId) ||
    !/^\d{10}$/.test(timestamp) ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) ||
    !/^[a-f0-9]{64}$/.test(suppliedBodyHash) ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(signature)
  ) {
    return null;
  }

  const timestampSeconds = Number.parseInt(timestamp, 10);
  const nowSeconds = Math.floor(input.now.getTime() / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > MAX_CLOCK_SKEW_SECONDS) return null;

  const actualBodyHash = sha256(input.rawBody);
  if (!safeEqual(actualBodyHash, suppliedBodyHash)) return null;

  const host = await input.store.getHostSecret(hostId);
  if (!host?.approvedAt || host.revokedAt) return null;

  let secret: string;
  try {
    secret = decryptString(host.secretCiphertext, input.config.masterKey);
  } catch {
    return null;
  }
  const url = new URL(input.request.url);
  const canonical = canonicalHostRequest({
    method: input.request.method,
    path: url.pathname,
    timestamp,
    nonce,
    bodyHash: actualBodyHash,
  });
  // Pairing issues the host secret as base64url. The Swift Bridge decodes those
  // bytes before HMAC, so the Relay must use the same key material.
  if (!safeEqual(hmacBase64url(Buffer.from(secret, "base64url"), canonical), signature)) {
    return null;
  }

  const nonceAccepted = await input.store.registerHostNonce(hostId, nonce, input.now);
  if (!nonceAccepted) return null;
  return { id: host.id, label: host.label };
}
