import { hmacBase64url, safeEqual } from "./crypto.ts";

export const SESSION_COOKIE = "codexpulse_session";
const SESSION_LIFETIME_SECONDS = 30 * 24 * 60 * 60;

interface SessionPayload {
  sub: "owner";
  iat: number;
  exp: number;
  version: 1;
}

export function createSession(secret: string, now = new Date()): string {
  const iat = Math.floor(now.getTime() / 1000);
  const payload: SessionPayload = {
    sub: "owner",
    iat,
    exp: iat + SESSION_LIFETIME_SECONDS,
    version: 1,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${hmacBase64url(secret, encoded)}`;
}

export function verifySession(token: string | null, secret: string, now = new Date()): boolean {
  if (!token) return false;
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return false;
  if (!safeEqual(signature, hmacBase64url(secret, encoded))) return false;
  try {
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Partial<SessionPayload>;
    const current = Math.floor(now.getTime() / 1000);
    return (
      payload.sub === "owner" &&
      payload.version === 1 &&
      typeof payload.iat === "number" &&
      typeof payload.exp === "number" &&
      payload.iat <= current + 60 &&
      payload.exp > current
    );
  } catch {
    return false;
  }
}

export function sessionCookie(token: string, secure: boolean): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    secure ? "Secure" : "",
    `Max-Age=${SESSION_LIFETIME_SECONDS}`,
  ]
    .filter(Boolean)
    .join("; ");
}

export function clearSessionCookie(secure: boolean): string {
  return [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    secure ? "Secure" : "",
    "Max-Age=0",
  ]
    .filter(Boolean)
    .join("; ");
}

export function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=") || null;
  }
  return null;
}
