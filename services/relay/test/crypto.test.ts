import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalHostRequest,
  decryptString,
  encryptString,
  hmacBase64url,
  safeEqual,
  sha256,
} from "../src/crypto.ts";

test("encrypts secrets with authenticated encryption", () => {
  const key = Buffer.alloc(32, 7);
  const encrypted = encryptString("host-secret", key);
  assert.notEqual(encrypted, "host-secret");
  assert.equal(decryptString(encrypted, key), "host-secret");
  assert.throws(() => decryptString(`${encrypted}tampered`, key));
});

test("builds the same content-bound host signature", () => {
  const body = '{"schemaVersion":1}';
  const canonical = canonicalHostRequest({
    method: "post",
    path: "/api/bridge/events",
    timestamp: "1786435200",
    nonce: "nonce_nonce_nonce_123",
    bodyHash: sha256(body),
  });
  const signature = hmacBase64url("secret", canonical);
  assert.equal(safeEqual(signature, hmacBase64url("secret", canonical)), true);
  assert.equal(safeEqual(signature, hmacBase64url("other", canonical)), false);
});
