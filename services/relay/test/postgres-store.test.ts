import assert from "node:assert/strict";
import test from "node:test";
import type { NeonQueryFunction } from "@neondatabase/serverless";
import { PostgresStore } from "../src/postgres-store.ts";

test("dashboard excludes revoked hosts from the active host list", async () => {
  const queries: string[] = [];
  const sql = (async (parts: TemplateStringsArray) => {
    queries.push(parts.join("?"));
    return [];
  }) as unknown as NeonQueryFunction<false, false>;
  const store = new PostgresStore("postgresql://unused", sql);

  await store.dashboard(new Date("2026-08-12T08:00:00.000Z"), {
    hosts: 2,
    subscriptions: 3,
    tasks: 200,
    events: 10_000,
    retentionDays: 7,
  });

  const hostQuery = queries.find((query) =>
    query.includes("bridge_version") && query.includes("FROM hosts")
  );
  assert.ok(hostQuery);
  assert.match(hostQuery, /approved_at IS NOT NULL AND revoked_at IS NULL/);
});
