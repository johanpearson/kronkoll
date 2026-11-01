/**
 * En riktig D1 (SQLite i workerd, via wranglers getPlatformProxy) utan persistens, med alla
 * migreringar körda i ordning precis som `wrangler d1 migrations apply`. Ingen data lämnar
 * maskinen.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import { getPlatformProxy } from "wrangler";

const ROOT = join(import.meta.dirname, "..");
const MIGRATIONS = join(ROOT, "migrations");

export async function migrationFiles(): Promise<string[]> {
  return (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql")).sort();
}

export async function migratedDb(): Promise<{ db: D1Database; dispose: () => Promise<void> }> {
  const proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: join(ROOT, "wrangler.test.jsonc"),
    persist: false,
  });
  const db = proxy.env.DB;
  for (const file of await migrationFiles()) {
    const sql = await readFile(join(MIGRATIONS, file), "utf8");
    const statements = sql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.replace(/^--.*$/gmu, "").trim() !== "");
    await db.batch(statements.map((s) => db.prepare(s)));
  }
  return { db, dispose: () => proxy.dispose() };
}
