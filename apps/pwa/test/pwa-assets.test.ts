import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("manifest is installable as a standalone Home Screen app", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.scope, "/");
  assert.match(String(manifest.start_url), /^\//);
});

test("service worker excludes authenticated API responses from cache", async () => {
  const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
  assert.match(source, /url\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(source, /\/assets\\\//);
  assert.match(source, /rootResponse\.clone\(\)/);
  assert.match(source, /candidate\.origin === self\.location\.origin/);
  assert.match(source, /new URL\("\/", self\.location\.origin\)/);
  assert.match(source, /showNotification/);
});
