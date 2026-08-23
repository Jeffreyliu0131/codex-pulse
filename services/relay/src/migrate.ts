import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { neon } from "@neondatabase/serverless";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("Missing required environment variable: DATABASE_URL");
const sql = neon(databaseUrl);
const migrationDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
const migrations = (await readdir(migrationDirectory))
  .filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name))
  .sort();

for (const name of migrations) {
  const migration = await readFile(join(migrationDirectory, name), "utf8");
  for (const statement of migration.split(/;\s*(?:\n|$)/).map((value) => value.trim()).filter(Boolean)) {
    await sql.query(statement);
  }
}
process.stdout.write(`CodexPulse database schema is up to date (${migrations.length} migrations).\n`);
