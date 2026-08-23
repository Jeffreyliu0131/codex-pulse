import assert from "node:assert/strict";
import test from "node:test";
import { encryptString, canonicalHostRequest, hmacBase64url, sha256 } from "../src/crypto.ts";
import { authenticateHost } from "../src/host-auth.ts";
import type { RelayConfig, RelayStore } from "../src/types.ts";

const now = new Date("2026-08-11T08:00:00.000Z");
const hostId = "019feffc-3299-70d3-b1dd-1fb8472f5e6c";
const hostSecret = Buffer.from("host-secret-value").toString("base64url");
const masterKey = Buffer.alloc(32, 3);
const seen = new Set<string>();

const store = {
  async getHostSecret() {
    return {
      id: hostId,
      label: "Mac mini",
      secretCiphertext: encryptString(hostSecret, masterKey),
      approvedAt: now.toISOString(),
      revokedAt: null,
    };
  },
  async registerHostNonce(_hostId: string, nonce: string) {
    if (seen.has(nonce)) return false;
    seen.add(nonce);
    return true;
  },
} as unknown as RelayStore;

const config = { masterKey } as RelayConfig;

function signedRequest(nonce: string, body: string): Request {
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const bodyHash = sha256(body);
  const signature = hmacBase64url(
    Buffer.from(hostSecret, "base64url"),
    canonicalHostRequest({
      method: "POST",
      path: "/api/bridge/events",
      timestamp,
      nonce,
      bodyHash,
    }),
  );
  return new Request("https://pulse.example/api/bridge/events", {
    method: "POST",
    body,
    headers: {
      "x-pulse-host-id": hostId,
      "x-pulse-timestamp": timestamp,
      "x-pulse-nonce": nonce,
      "x-pulse-body-sha256": bodyHash,
      "x-pulse-signature": signature,
    },
  });
}

test("uses the decoded base64url host secret as the HMAC key", () => {
  const canonical = "POST\n/api/bridge/events\n1786435200\nnonce_nonce_nonce_3\nbody-hash";
  assert.equal(
    hmacBase64url(Buffer.from(hostSecret, "base64url"), canonical),
    "06qLRsrV66kdEOOTE0mMhmEwnGEObagS_0MEB0Z8TK4",
  );
});

test("accepts one content-bound request and rejects replay", async () => {
  seen.clear();
  const body = '{"schemaVersion":1}';
  const request = signedRequest("nonce_nonce_nonce_1", body);
  assert.deepEqual(await authenticateHost({ request, rawBody: body, store, config, now }), {
    id: hostId,
    label: "Mac mini",
  });

  const replay = signedRequest("nonce_nonce_nonce_1", body);
  assert.equal(await authenticateHost({ request: replay, rawBody: body, store, config, now }), null);
});

test("rejects a body changed after signing", async () => {
  seen.clear();
  const request = signedRequest("nonce_nonce_nonce_2", "{}");
  assert.equal(
    await authenticateHost({ request, rawBody: '{"changed":true}', store, config, now }),
    null,
  );
});
