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

/** Kör en migreringsfil i en batch, som wrangler. */
export async function applyMigration(db: D1Database, file: string): Promise<void> {
  const sql = await readFile(join(MIGRATIONS, file), "utf8");
  const statements = sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.replace(/^--.*$/gmu, "").trim() !== "");
  await db.batch(statements.map((s) => db.prepare(s)));
}

/** En migrerad D1. Med `before` körs bara migreringarna före den filen, för att testa en migrering på gammal data. */
export async function migratedDb(options: { before?: string } = {}): Promise<{ db: D1Database; dispose: () => Promise<void> }> {
  const proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: join(ROOT, "wrangler.test.jsonc"),
    persist: false,
  });
  const db = proxy.env.DB;
  const { before } = options;
  for (const file of await migrationFiles()) {
    if (before !== undefined && file >= before) break;
    await applyMigration(db, file);
  }
  return { db, dispose: () => proxy.dispose() };
}

/** En ny slumpad SESSION_ENC_KEY per testkörning. Ingen nyckel finns i repot (KK-12). */
export function randomSecret(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
}
