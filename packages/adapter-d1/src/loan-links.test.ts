import type { D1Database } from "@cloudflare/workers-types";
import { linkLoans } from "@kronkoll/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deriveKeys } from "./crypto.ts";
import { loanLinkRepository } from "./loan-links.ts";
import { loanRepository } from "./loans.ts";
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

/** Påhittade lån och betalningar, i bankens format men med påhittade kontonummer (KK-13, KK-59-E). */
const LOAN = { id: "lan1", name: "Bolån", lender: null, balanceMinor: 100_000_000, interestRateBp: 350, rateFixedUntil: null, amortizationMinor: 200_000 };
const ROWS: [string, string, number, string, string][] = [
  ["bet-nov", "2026-11-27", -812_500, "booked", "Betalning 9020 1234567"],
  ["bet-okt", "2026-08-27", -812_500, "booked", "BG 9020.12.34567"],
  ["ica", "2026-11-20", -41_250, "booked", "ICA NARA EXEMPEL"],
  ["insattning", "2026-11-27", 812_500, "booked", "Betalning 9020 1234567"],
  ["borta", "2026-11-26", -812_500, "removed", "Betalning 9020 1234567"],
];

beforeEach(async () => {
  await db.batch([db.prepare(`DELETE FROM transactions`), db.prepare(`DELETE FROM loans`)]);
  await loanRepository(db).save(LOAN);
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
  return db.prepare(`SELECT loan_id AS loan, loan_source AS source, category_id AS category, category_source AS cs FROM transactions WHERE id = ?`).bind(id).first();
}

/** Samma steg som synken kör: matcha i domänen och skriv kopplingarna. */
async function link(since: string | null = null) {
  const repo = loanLinkRepository(db);
  const matching = await repo.matchers();
  const changes = linkLoans(await repo.candidates(since), matching);
  await repo.apply(changes, matching);
  return changes;
}

describe("lånens matchningstexter (KK-59-A)", () => {
  it("sparas med kategori och läses tillbaka, och ett lån utan texter har en tom lista", async () => {
    const repo = loanLinkRepository(db);
    expect(await repo.matchers()).toEqual([{ loanId: "lan1", patterns: [], categoryId: null }]);
    expect(await repo.setMatching("lan1", ["9020-12 345 67", "<b>OCR</b>"], category)).toBe(true);
    expect(await repo.matchers()).toEqual([{ loanId: "lan1", patterns: ["9020-12 345 67", "<b>OCR</b>"], categoryId: category }]);
    expect(await repo.setMatching("saknas", [], null)).toBe(false);
  });

  it("en trasig lista i databasen räknas som inga texter, så att synken inte stoppas", async () => {
    await db.prepare(`UPDATE loans SET match_patterns = 'inte json' WHERE id = 'lan1'`).run();
    expect((await loanLinkRepository(db).matchers())[0]?.patterns).toEqual([]);
    await db.prepare(`UPDATE loans SET match_patterns = '{"a":1}' WHERE id = 'lan1'`).run();
    expect((await loanLinkRepository(db).matchers())[0]?.patterns).toEqual([]);
    await db.prepare(`UPDATE loans SET match_patterns = '["ok", 5]' WHERE id = 'lan1'`).run();
    expect((await loanLinkRepository(db).matchers())[0]?.patterns).toEqual(["ok"]);
  });
});

describe("kopplingar i D1 (KK-59-B)", () => {
  it("kopplar betalningarna, ger lånets kategori och låter insättningar och borttagna vara", async () => {
    await loanLinkRepository(db).setMatching("lan1", ["9020-12 345 67"], category);
    expect((await link()).map((c) => c.id).sort()).toEqual(["bet-nov", "bet-okt"]);
    expect(await row("bet-nov")).toEqual({ loan: "lan1", source: "auto", category, cs: "learned" });
    expect(await row("insattning")).toEqual({ loan: null, source: null, category: null, cs: "none" });
    expect(await row("borta")).toMatchObject({ loan: null });
    // En andra körning ändrar ingenting.
    expect(await link()).toEqual([]);
  });

  it("utan datum hämtas all historik, med datum bara därifrån, plus allt som redan är kopplat", async () => {
    await loanLinkRepository(db).setMatching("lan1", ["9020-12 345 67"], null);
    expect((await link("2026-11-01")).map((c) => c.id)).toEqual(["bet-nov"]);
    expect((await loanLinkRepository(db).candidates("2026-11-25")).map((c) => c.id).sort()).toEqual(["bet-nov"]);
    await db.prepare(`UPDATE transactions SET loan_id = 'lan1', loan_source = 'auto' WHERE id = 'bet-okt'`).run();
    expect((await loanLinkRepository(db).candidates("2026-11-25")).map((c) => c.id).sort()).toEqual(["bet-nov", "bet-okt"]);
  });

  it("ett lån utan kategori kopplar bara, och en manuell kategori skrivs aldrig över", async () => {
    await db.prepare(`UPDATE transactions SET category_id = ?, category_source = 'manual' WHERE id = 'bet-okt'`).bind(category).run();
    await loanLinkRepository(db).setMatching("lan1", ["9020-12 345 67"], null);
    await link();
    expect(await row("bet-nov")).toEqual({ loan: "lan1", source: "auto", category: null, cs: "none" });
    await loanLinkRepository(db).setMatching("lan1", ["9020-12 345 67"], category);
    await db.prepare(`UPDATE transactions SET loan_id = NULL, loan_source = NULL`).run();
    await link();
    expect(await row("bet-okt")).toEqual({ loan: "lan1", source: "auto", category, cs: "manual" });
  });

  it("när texten inte längre träffar tas kopplingen och lånets kategori bort, så att reglerna kan sätta en ny", async () => {
    const repo = loanLinkRepository(db);
    await repo.setMatching("lan1", ["9020-12 345 67"], category);
    await link();
    await repo.setMatching("lan1", ["OCR 4455"], category);
    await link();
    expect(await row("bet-nov")).toEqual({ loan: null, source: null, category: null, cs: "none" });
  });

  it("manuella kopplingar och manuellt borttagna kopplingar rörs inte", async () => {
    await db.batch([
      db.prepare(`UPDATE transactions SET loan_source = 'manual' WHERE id = 'bet-nov'`),
      db.prepare(`UPDATE transactions SET loan_id = 'lan1', loan_source = 'manual' WHERE id = 'ica'`),
    ]);
    await loanLinkRepository(db).setMatching("lan1", ["9020-12 345 67"], category);
    await link();
    expect(await row("bet-nov")).toEqual({ loan: null, source: "manual", category: null, cs: "none" });
    expect(await row("ica")).toMatchObject({ loan: "lan1", source: "manual" });
    // Även om domänen skulle föreslå en ändring skriver adaptern inte över en manuell koppling.
    await loanLinkRepository(db).apply([{ id: "ica", loanId: null }, { id: "bet-nov", loanId: "lan1" }], await loanLinkRepository(db).matchers());
    expect(await row("ica")).toMatchObject({ loan: "lan1", source: "manual" });
    expect(await row("bet-nov")).toMatchObject({ loan: null, source: "manual" });
  });

  it("ger lånens betalningar i en period, utan borttagna och okopplade (KK-59-C)", async () => {
    await db.batch([
      db.prepare(`UPDATE transactions SET loan_id = 'lan1', loan_source = 'auto' WHERE id IN ('bet-nov', 'bet-okt', 'borta')`),
    ]);
    const repo = loanLinkRepository(db);
    expect((await repo.payments("2026-11-01", "2026-11-30")).map((p) => [p.id, p.loanId, p.amountMinor])).toEqual([["bet-nov", "lan1", -812_500]]);
    expect(await repo.payments("2026-12-01", "2026-12-31")).toEqual([]);
  });

  it("kopplade betalningar räknas inte om av reglerna, och ett borttaget lån släpper kopplingen", async () => {
    await loanLinkRepository(db).setMatching("lan1", ["9020-12 345 67"], null);
    await link();
    const store = transactionRepository(db);
    expect((await store.uncategorized()).map((t) => t.id).sort()).toEqual(["ica", "insattning"]);
    expect((await store.categorizable()).map((t) => t.id).sort()).toEqual(["ica", "insattning"]);
    expect(await loanRepository(db).remove("lan1")).toBe(true);
    expect(await row("bet-nov")).toMatchObject({ loan: null });
  });
});
