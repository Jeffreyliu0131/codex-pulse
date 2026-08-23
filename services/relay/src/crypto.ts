import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export function base64url(input: Buffer): string {
  return input.toString("base64url");
}

export function randomToken(bytes = 32): string {
  return base64url(randomBytes(bytes));
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hmacBase64url(secret: string | Buffer, value: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function encryptString(value: string, key: Buffer): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [nonce, tag, ciphertext].map(base64url).join(".");
}

export function decryptString(value: string, key: Buffer): string {
  const [nonceValue, tagValue, ciphertextValue] = value.split(".");
  if (!nonceValue || !tagValue || !ciphertextValue) {
    throw new Error("Invalid encrypted value");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(nonceValue, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function canonicalHostRequest(input: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  bodyHash: string;
}): string {
  return [
    input.method.toUpperCase(),
    input.path,
    input.timestamp,
    input.nonce,
    input.bodyHash,
  ].join("\n");
}
