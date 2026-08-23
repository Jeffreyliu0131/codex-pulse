import assert from "node:assert/strict";
import test from "node:test";
import { createSession, verifySession } from "../src/session.ts";

test("session is signed and expires", () => {
  const start = new Date("2026-08-11T08:00:00.000Z");
  const token = createSession("s".repeat(48), start);
  assert.equal(verifySession(token, "s".repeat(48), start), true);
  assert.equal(verifySession(`${token}x`, "s".repeat(48), start), false);
  assert.equal(
    verifySession(token, "s".repeat(48), new Date("2026-09-11T08:00:00.000Z")),
    false,
  );
});
