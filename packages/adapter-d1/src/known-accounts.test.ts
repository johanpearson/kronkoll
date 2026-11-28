import type { D1Database } from "@cloudflare/workers-types";
import { linkKnownAccounts } from "@kronkoll/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { categoryRepository } from "./categories.ts";
import { deriveKeys } from "./crypto.ts";
import { knownAccountRepository } from "./known-accounts.ts";
import { accountRepository, connectionRepository } from "./repositories.ts";
import { migratedDb, randomSecret } from "./test-support.ts";
import { transactionRepository } from "./transactions.ts";

let db: D1Database;
let dispose: () => Promise<void>;
let category: string;

beforeAll(async () => {
  ({ db, dispose } = await migratedDb());
  const keys = await deriveKeys(randomSecret());
  await connectionRepository(db, keys).create({ id: "c1", provider: "enablebanking", aspspName: "Skandia" });
  await accountRepository(db, keys).upsertFromBank({ connectionId: "c1", providerUid: "u1", iban: null, name: "Privatkonto", type: "checking", balanceMinor: 0 }, () => "acc_1");
  category = (await db.prepare(`SELECT id FROM categories WHERE parent_id IS NOT NULL ORDER BY id LIMIT 1`).first<{ id: string }>())?.id ?? "";
});
afterAll(async () => {
  await dispose();
});

/** Påhittade överföringar i Skandias format: ingen motpart, bara meddelandet (KK-13). */
const ROWS: [string, string, number, string, string][] = [
  ["till-a", "2026-11-27", -200_000, "booked", "Swish till Exempelkonto A"],
  ["till-a2", "2026-10-27", -150_000, "booked", "swish  till exempelkonto a 2"],
  ["ica", "2026-11-20", -41_250, "booked", "ICA NARA EXEMPEL"],
  ["borta", "2026-11-26", -9_900, "removed", "Swish till Exempelkonto A"],
];

beforeEach(async () => {
  await db.batch([db.prepare(`DELETE FROM transactions`), db.prepare(`DELETE FROM known_accounts`)]);
  await db.batch(
    ROWS.map(([id, date, amount, status, description]) =>
      db
        .prepare(
          `INSERT INTO transactions (id, account_id, fingerprint, status, last_seen_at, transaction_date, booking_date, amount_minor, description)
           VALUES (?, 'acc_1', 'fp', ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, status, date, date, date, amount, description),
    ),
  );
});

async function row(id: string) {
  return db.prepare(`SELECT known_account_id AS ka, known_account_source AS source, category_id AS category, category_source AS cs FROM transactions WHERE id = ?`).bind(id).first();
}

/** Samma steg som synken kör: matcha i domänen och skriv kopplingarna. */
async function link(since: string | null = null) {
  const repo = knownAccountRepository(db);
  const accounts = await repo.list();
  const changes = linkKnownAccounts(await repo.candidates(since), accounts);
  await repo.apply(changes, accounts);
  return changes;
}

const A = { id: "ka1", name: "Konto A", patterns: ["SWISH TILL EXEMPELKONTO A"], categoryId: null as string | null };

describe("kända konton i D1 (KK-54-A)", () => {
  it("sparar, listar i den ordning de lades till, ändrar och tar bort", async () => {
    const repo = knownAccountRepository(db);
    expect(await repo.save({ ...A, categoryId: category })).toBe(true);
    expect(await repo.save({ id: "ka2", name: "Barnspar", patterns: ["<b>BARN</b>"], categoryId: null })).toBe(true);
    expect((await repo.list()).map((a) => a.id)).toEqual(["ka1", "ka2"]);
    expect(await repo.get("ka2")).toEqual({ id: "ka2", name: "Barnspar", patterns: ["<b>BARN</b>"], categoryId: null });
    expect(await repo.get("saknas")).toBeNull();
    expect(await repo.save({ ...A, name: "Nytt namn", categoryId: category })).toBe(false);
    expect((await repo.get("ka1"))?.name).toBe("Nytt namn");
    expect(await repo.remove("ka2")).toBe(true);
    expect(await repo.remove("ka2")).toBe(false);
  });

  it("en trasig lista i databasen räknas som inga texter, så att synken inte stoppas", async () => {
    const repo = knownAccountRepository(db);
    await repo.save(A);
    await db.prepare(`UPDATE known_accounts SET match_patterns = 'inte json'`).run();
    expect((await repo.list())[0]?.patterns).toEqual([]);
    await db.prepare(`UPDATE known_accounts SET match_patterns = '["ok", 5]'`).run();
    expect((await repo.list())[0]?.patterns).toEqual(["ok"]);
  });

  it("en borttagen kategori gör kontots kategori tom i stället för att stoppa borttagningen", async () => {
    await db.prepare(`INSERT INTO categories (id, parent_id, name, kind, archived) VALUES ('tmp-kat', NULL, 'Tillfällig', 'expense', 0)`).run();
    await knownAccountRepository(db).save({ ...A, categoryId: "tmp-kat" });
    await db.prepare(`DELETE FROM categories WHERE id = 'tmp-kat'`).run();
    expect((await knownAccountRepository(db).get("ka1"))?.categoryId).toBeNull();
  });
});

describe("kopplingar i D1 (KK-54-B)", () => {
  it("kopplar överföringarna, ger kontots kategori och låter borttagna vara", async () => {
    await knownAccountRepository(db).save({ ...A, categoryId: category });
    expect((await link()).map((c) => c.id).sort()).toEqual(["till-a", "till-a2"]);
    expect(await row("till-a")).toEqual({ ka: "ka1", source: "auto", category, cs: "learned" });
    expect(await row("ica")).toEqual({ ka: null, source: null, category: null, cs: "none" });
    expect(await row("borta")).toMatchObject({ ka: null });
    expect((await transactionRepository(db).detail("till-a"))?.knownAccount).toEqual({ id: "ka1", name: "Konto A", source: "auto" });
    expect(await link()).toEqual([]);
  });

  it("utan datum hämtas all historik, med datum bara därifrån, plus allt som redan är kopplat", async () => {
    await knownAccountRepository(db).save(A);
    expect((await link("2026-11-01")).map((c) => c.id)).toEqual(["till-a"]);
    expect((await knownAccountRepository(db).candidates("2026-11-25")).map((c) => c.id)).toEqual(["till-a"]);
    await db.prepare(`UPDATE transactions SET known_account_id = 'ka1', known_account_source = 'auto' WHERE id = 'till-a2'`).run();
    expect((await knownAccountRepository(db).candidates("2026-11-25")).map((c) => c.id).sort()).toEqual(["till-a", "till-a2"]);
  });

  it("ett konto utan kategori kopplar bara, och en manuell kategori skrivs aldrig över", async () => {
    await db.prepare(`UPDATE transactions SET category_id = ?, category_source = 'manual' WHERE id = 'till-a2'`).bind(category).run();
    const repo = knownAccountRepository(db);
    await repo.save(A);
    await link();
    expect(await row("till-a")).toEqual({ ka: "ka1", source: "auto", category: null, cs: "none" });
    await repo.save({ ...A, categoryId: category });
    await link("2026-11-01");
    expect(await row("till-a2")).toEqual({ ka: "ka1", source: "auto", category, cs: "manual" });
  });

  it("när texten inte längre träffar tas kopplingen och kontots kategori bort, så att reglerna kan sätta en ny", async () => {
    const repo = knownAccountRepository(db);
    await repo.save({ ...A, categoryId: category });
    await link();
    await repo.save({ ...A, patterns: ["HELT ANNAT"], categoryId: category });
    await link();
    expect(await row("till-a")).toEqual({ ka: null, source: null, category: null, cs: "none" });
  });

  it("manuella kopplingar och manuellt borttagna kopplingar rörs inte, inte ens av adaptern", async () => {
    const repo = knownAccountRepository(db);
    await repo.save({ ...A, categoryId: category });
    await db.batch([
      db.prepare(`UPDATE transactions SET known_account_source = 'manual' WHERE id = 'till-a'`),
      db.prepare(`UPDATE transactions SET known_account_id = 'ka1', known_account_source = 'manual' WHERE id = 'ica'`),
    ]);
    await link();
    expect(await row("till-a")).toEqual({ ka: null, source: "manual", category: null, cs: "none" });
    expect(await row("ica")).toMatchObject({ ka: "ka1", source: "manual" });
    await repo.apply([{ id: "ica", knownAccountId: null }, { id: "till-a", knownAccountId: "ka1" }], await repo.list());
    expect(await row("ica")).toMatchObject({ ka: "ka1", source: "manual" });
    expect(await row("till-a")).toMatchObject({ ka: null, source: "manual" });
  });

  it("kopplade överföringar räknas inte om av reglerna, och ett borttaget konto släpper kopplingen", async () => {
    const repo = knownAccountRepository(db);
    await repo.save(A);
    await link();
    const store = transactionRepository(db);
    expect((await store.uncategorized()).map((t) => t.id)).toEqual(["ica"]);
    expect((await store.categorizable()).map((t) => t.id)).toEqual(["ica"]);
    expect(await repo.remove("ka1")).toBe(true);
    expect(await row("till-a")).toMatchObject({ ka: null });
  });

  it("en sammanslagning av kategorier flyttar kontots kategori", async () => {
    await db.prepare(`INSERT INTO categories (id, parent_id, name, kind, archived) VALUES ('tmp-kat', NULL, 'Tillfällig', 'expense', 0)`).run();
    await knownAccountRepository(db).save({ ...A, categoryId: "tmp-kat" });
    await categoryRepository(db).merge("tmp-kat", category, []);
    expect((await knownAccountRepository(db).get("ka1"))?.categoryId).toBe(category);
  });
});

describe("koppla för hand (KK-54-C)", () => {
  it("kopplar en överföring som manuell, med kontots kategori, och en ny synk rör den inte", async () => {
    const repo = knownAccountRepository(db);
    await repo.save({ ...A, categoryId: category });
    expect(await repo.setManual("ica", "ka1")).toBe(true);
    expect(await row("ica")).toEqual({ ka: "ka1", source: "manual", category, cs: "learned" });
    expect((await transactionRepository(db).detail("ica"))?.knownAccount).toEqual({ id: "ka1", name: "Konto A", source: "manual" });
    await repo.save({ ...A, patterns: ["SWISH TILL EXEMPELKONTO A"], categoryId: category });
    await link();
    expect(await row("ica")).toMatchObject({ ka: "ka1", source: "manual" });
  });

  it("tar bort en koppling för hand: kategorin släpps, och matchningen kopplar den inte igen", async () => {
    const repo = knownAccountRepository(db);
    await repo.save({ ...A, categoryId: category });
    await link();
    expect(await repo.setManual("till-a", null)).toBe(true);
    expect(await row("till-a")).toEqual({ ka: null, source: "manual", category: null, cs: "none" });
    await link();
    expect(await row("till-a")).toMatchObject({ ka: null, source: "manual" });
  });

  it("en manuell kategori ligger kvar både när överföringen kopplas och när kopplingen tas bort", async () => {
    await db.prepare(`UPDATE transactions SET category_id = ?, category_source = 'manual' WHERE id = 'ica'`).bind(category).run();
    const repo = knownAccountRepository(db);
    await repo.save({ ...A, categoryId: "mat-livsmedel" });
    await repo.setManual("ica", "ka1");
    expect(await row("ica")).toMatchObject({ category, cs: "manual" });
    await repo.setManual("ica", null);
    expect(await row("ica")).toEqual({ ka: null, source: "manual", category, cs: "manual" });
  });

  it("ett konto eller en transaktion som inte finns, eller en borttagen transaktion, ger falskt och ändrar inget", async () => {
    const repo = knownAccountRepository(db);
    await repo.save(A);
    expect(await repo.setManual("ica", "saknas")).toBe(false);
    expect(await repo.setManual("saknas", "ka1")).toBe(false);
    expect(await repo.setManual("borta", "ka1")).toBe(false);
    expect(await row("ica")).toEqual({ ka: null, source: null, category: null, cs: "none" });
  });
});
