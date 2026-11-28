import type { D1Database } from "@cloudflare/workers-types";
import { reconcile, type ImportedTransaction, type StoredTransaction } from "@kronkoll/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deriveKeys } from "./crypto.ts";
import { accountRepository, connectionRepository } from "./repositories.ts";
import { transactionRepository } from "./transactions.ts";
import { migratedDb, randomSecret } from "./test-support.ts";

let db: D1Database;
let dispose: () => Promise<void>;
let acc1: string;
let acc2: string;

beforeAll(async () => {
  ({ db, dispose } = await migratedDb());
  const keys = await deriveKeys(randomSecret());
  await connectionRepository(db, keys).create({ id: "c1", provider: "enablebanking", aspspName: "Skandia" });
  const accounts = accountRepository(db, keys);
  const base = { connectionId: "c1", iban: null, type: "checking" as const, balanceMinor: 0 };
  acc1 = await accounts.upsertFromBank({ ...base, providerUid: "u1", name: "Privatkonto" }, () => "acc_1");
  acc2 = await accounts.upsertFromBank({ ...base, providerUid: "u2", name: "Sparkonto" }, () => "acc_2");
});
afterAll(async () => {
  await dispose();
});

let seq = 0;
const newId = () => `tx_${String(++seq)}`;

function imported(overrides: Partial<ImportedTransaction> = {}): ImportedTransaction {
  return {
    accountId: acc1,
    providerTxId: null,
    status: "booked",
    transactionDate: "2026-11-10",
    bookingDate: "2026-11-10",
    amountMinor: -4500,
    counterpartyNorm: "ESPRESSO HOUSE",
    counterparty: "ESPRESSO HOUSE STHLM",
    description: "Kaffe",
    ...overrides,
  };
}

/** Kör en synk mot databasen på samma sätt som orkestreringen kommer att göra. */
async function sync(incoming: ImportedTransaction[], today: string, options: { dateFrom?: string | null; accountIds?: string[] } = {}) {
  const repo = transactionRepository(db);
  const accountIds = options.accountIds ?? [acc1, acc2];
  const existing = await repo.forReconcile(accountIds, options.dateFrom ?? null);
  const result = reconcile({ existing, incoming, accountIds, today, newId });
  await repo.save(result);
  return result;
}

async function rows(accountId = acc1) {
  return (await transactionRepository(db).forReconcile([accountId], null)).sort((a, b) => a.id.localeCompare(b.id, "sv"));
}

describe("transaktioner i D1 (KK-9, KK-7-A)", () => {
  it("sparar nya rader med bankens text och läser tillbaka dem som StoredTransaction", async () => {
    const result = await sync([imported({ providerTxId: "p1" })], "2026-11-11");
    expect(result.inserted).toHaveLength(1);
    expect(await rows()).toEqual([
      { ...imported({ providerTxId: "p1" }), id: result.inserted[0]?.id, lastSeenOn: "2026-11-11" },
    ]);
  });

  it("en ny synk av samma data samma dag skriver ingenting (idempotent)", async () => {
    const result = await sync([imported({ providerTxId: "p1" })], "2026-11-11");
    expect(result).toEqual({ inserted: [], updated: [] });
  });

  it("en preliminär som bokförs behåller sitt id och tar bankens nya belopp, id och text", async () => {
    const pending = imported({ accountId: acc2, status: "pending", providerTxId: "pend-1", bookingDate: null, amountMinor: -10000, counterparty: "MAXI", description: "" });
    const first = await sync([pending], "2026-11-11");
    const id = first.inserted[0]?.id;
    const second = await sync(
      [imported({ accountId: acc2, status: "booked", providerTxId: "book-1", amountMinor: -11500, counterparty: "MAXI ICA STHLM", description: "Dricks" })],
      "2026-11-13",
    );
    expect(second.inserted).toEqual([]);
    expect(await rows(acc2)).toEqual([
      { ...imported({ accountId: acc2, providerTxId: "book-1", amountMinor: -11500, counterparty: "MAXI ICA STHLM", description: "Dricks" }), id, lastSeenOn: "2026-11-13" },
    ]);
  });

  it("en försvunnen preliminär får status removed och finns kvar i läsningen så att den kan återvända", async () => {
    await sync([imported({ accountId: acc2, status: "pending", providerTxId: "pend-2", bookingDate: null, amountMinor: -700, counterpartyNorm: "KIOSK", counterparty: "KIOSK", description: "" })], "2026-11-01");
    await sync([], "2026-11-20", { accountIds: [acc2] });
    const removed = (await rows(acc2)).filter((r) => r.providerTxId === "pend-2");
    expect(removed).toMatchObject([{ status: "removed" }]);
  });

  it("kategori, uppdelning och överföringsmarkering rörs inte när raden uppdateras", async () => {
    await db.prepare(`UPDATE transactions SET category_source = 'manual', is_internal_transfer = 1 WHERE provider_tx_id = 'p1'`).run();
    await sync([imported({ providerTxId: "p1", description: "Kaffe och bulle" })], "2026-11-14");
    const row = await db
      .prepare(`SELECT description, category_source AS source, is_internal_transfer AS transfer FROM transactions WHERE provider_tx_id = 'p1'`)
      .first<{ description: string; source: string; transfer: number }>();
    expect(row).toEqual({ description: "Kaffe och bulle", source: "manual", transfer: 1 });
  });

  it("när en preliminär bokförs släpps kategorin från en regel, så att reglerna sätts igen, men en manuell ligger kvar (KK-56-B)", async () => {
    const pend = (id: string, amountMinor: number) =>
      imported({ status: "pending", providerTxId: id, bookingDate: null, amountMinor, counterpartyNorm: "", counterparty: "", description: `BUTIK${id.toUpperCase()}` });
    await sync([pend("r1", -2000), pend("m1", -3000), pend("s1", -4000)], "2026-11-14");
    await db.prepare(`UPDATE transactions SET category_id = 'mat-livsmedel', category_source = 'template' WHERE provider_tx_id = 'r1'`).run();
    await db.prepare(`UPDATE transactions SET category_id = 'mat-livsmedel', category_source = 'manual' WHERE provider_tx_id = 'm1'`).run();
    await db.prepare(`UPDATE transactions SET category_id = 'mat-livsmedel', category_source = 'learned' WHERE provider_tx_id = 's1'`).run();
    // r1 och m1 bokförs. s1 är fortfarande preliminär och behåller sin kategori.
    await sync([{ ...pend("r1", -2000), status: "booked", bookingDate: "2026-11-15" }, { ...pend("m1", -3000), status: "booked", bookingDate: "2026-11-15" }, pend("s1", -4000)], "2026-11-15");
    const { results } = await db
      .prepare(`SELECT provider_tx_id AS id, status, category_id AS category, category_source AS source FROM transactions WHERE provider_tx_id IN ('r1', 'm1', 's1') ORDER BY provider_tx_id`)
      .all();
    expect(results).toEqual([
      { id: "m1", status: "booked", category: "mat-livsmedel", source: "manual" },
      { id: "r1", status: "booked", category: null, source: "none" },
      { id: "s1", status: "pending", category: "mat-livsmedel", source: "learned" },
    ]);
    // En bokförd som synkas igen släpper inte sin kategori.
    await db.prepare(`UPDATE transactions SET category_id = 'mat-livsmedel', category_source = 'template' WHERE provider_tx_id = 'r1'`).run();
    await sync([{ ...pend("r1", -2000), status: "booked", bookingDate: "2026-11-15", description: "BUTIKR1 NY TEXT" }], "2026-11-16");
    expect(await db.prepare(`SELECT category_source AS source FROM transactions WHERE provider_tx_id = 'r1'`).first()).toEqual({ source: "template" });
  });

  it("läser bara det som behövs för avstämningen: från datumgränsen minus matchningsfönstret (3 dagar), plus alla preliminära", async () => {
    const repo = transactionRepository(db);
    await db.prepare(`DELETE FROM transactions`).run();
    await sync(
      [
        imported({ transactionDate: "2026-09-01", bookingDate: "2026-09-01", amountMinor: -1, providerTxId: "gammal" }),
        imported({ transactionDate: "2026-10-28", bookingDate: "2026-10-28", amountMinor: -5, providerTxId: "precis-utanfor" }),
        imported({ transactionDate: "2026-10-29", bookingDate: "2026-10-29", amountMinor: -2, providerTxId: "gransen" }),
        imported({ transactionDate: "2026-11-05", bookingDate: "2026-11-05", amountMinor: -3, providerTxId: "ny" }),
        imported({ status: "pending", transactionDate: "2026-08-01", bookingDate: null, amountMinor: -4, providerTxId: "gammal-prel" }),
      ],
      "2026-11-06",
    );
    const read = await repo.forReconcile([acc1], "2026-11-01");
    expect(read.map((r) => r.providerTxId).sort()).toEqual(["gammal-prel", "gransen", "ny"]);
  });

  it("senaste bokförda dag per konto, eller null utan bokförda", async () => {
    const repo = transactionRepository(db);
    expect(await repo.latestBookedDate(acc1)).toBe("2026-11-05");
    expect(await repo.latestBookedDate("saknas")).toBeNull();
  });

  it("alla skrivningar för en synk sker tillsammans: ett fel lämnar databasen oförändrad", async () => {
    const repo = transactionRepository(db);
    const before = await rows();
    const good: StoredTransaction = { ...imported({ providerTxId: "ok-1", amountMinor: -9 }), id: "tx_good", status: "booked", lastSeenOn: "2026-11-15" };
    const bad: StoredTransaction = { ...good, id: "tx_bad", providerTxId: "ok-2", description: "x".repeat(141) };
    await expect(repo.save({ inserted: [good, bad], updated: [] })).rejects.toThrow();
    expect(await rows()).toEqual(before);
  });

  it("sparar ingen bankdata utöver de kolumner schemat har (inga råa svar)", async () => {
    const columns = await db.prepare(`SELECT name FROM pragma_table_info('transactions')`).all<{ name: string }>();
    expect(columns.results.map((c) => c.name)).not.toContain("raw");
  });
});
