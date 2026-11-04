import type { D1Database } from "@cloudflare/workers-types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deriveKeys } from "./crypto.ts";
import { accountRepository, connectionRepository } from "./repositories.ts";
import { migratedDb, randomSecret } from "./test-support.ts";
import { transactionRepository, type TransactionListQuery } from "./transactions.ts";

let db: D1Database;
let dispose: () => Promise<void>;
let categoryId: string;

/** Påhittade transaktioner (KK-13): id, datum, belopp, motpart, beskrivning, status, kategori. */
const ROWS: [string, string, number, string, string, "booked" | "pending" | "removed", boolean][] = [
  ["t01", "2026-10-31", -10000, "ICA NÄRA SOFO", "Kortköp", "booked", true],
  ["t02", "2026-11-01", -41250, "ICA Nära Sofo", "Kortköp", "pending", true],
  ["t03", "2026-11-01", -28600, "K*RESTAURANG TAKO", "", "booked", false],
  ["t04", "2026-11-02", 2500000, "ARBETSGIVAREN AB", "Lön november", "booked", false],
  ["t05", "2026-11-03", -5000, "100% RABATT", "50% på allt", "booked", false],
  ["t06", "2026-11-04", -9900, "BORTTAGEN PRELIMINÄR", "", "removed", false],
  ["t07", "2026-11-30", -12000, "SISTA DAGEN", "", "booked", false],
  ["t08", "2026-12-01", -13000, "NÄSTA MÅNAD", "", "booked", false],
];

beforeAll(async () => {
  ({ db, dispose } = await migratedDb());
  const keys = await deriveKeys(randomSecret());
  await connectionRepository(db, keys).create({ id: "c1", provider: "enablebanking", aspspName: "Skandia" });
  await accountRepository(db, keys).upsertFromBank({ connectionId: "c1", providerUid: "u1", iban: null, name: "Privatkonto", type: "checking", balanceMinor: 0 }, () => "acc_1");
  categoryId = (await db.prepare(`SELECT id FROM categories WHERE parent_id IS NOT NULL ORDER BY id LIMIT 1`).first<{ id: string }>())?.id ?? "";
  await db.batch(
    ROWS.map(([id, date, amount, counterparty, description, status, categorized]) =>
      db
        .prepare(
          `INSERT INTO transactions (id, account_id, fingerprint, status, last_seen_at, transaction_date, booking_date, amount_minor, counterparty, counterparty_norm, description, category_id, category_source)
           VALUES (?, 'acc_1', 'fp', ?, ?, ?, ?, ?, ?, upper(?), ?, ?, ?)`,
        )
        .bind(id, status, date, date, status === "pending" ? null : date, amount, counterparty, counterparty, description, categorized ? categoryId : null, categorized ? "template" : "none"),
    ),
  );
  await db.prepare(`UPDATE transactions SET is_internal_transfer = 1 WHERE id = 't04'`).run();
  await db.prepare(`INSERT INTO transaction_splits (id, transaction_id, category_id, amount_minor) VALUES ('s1', 't03', ?, -28600)`).bind(categoryId).run();
});
afterAll(async () => {
  await dispose();
});

const NOVEMBER = { from: "2026-11-01", to: "2026-11-30", limit: 50 } satisfies TransactionListQuery;
const ids = async (query: Partial<TransactionListQuery> = {}) => (await transactionRepository(db).list({ ...NOVEMBER, ...query })).items.map((t) => t.id);

describe("lista transaktioner (KK-9, KK-18, #32)", () => {
  it("ger periodens transaktioner, nyast först, båda ändarna inräknade, utan borttagna preliminära", async () => {
    expect(await ids()).toEqual(["t07", "t05", "t04", "t03", "t02"]);
  });

  it("ger allt som vyn behöver, och bankens text som den kom", async () => {
    const { items } = await transactionRepository(db).list(NOVEMBER);
    expect(items.find((t) => t.id === "t02")).toEqual({
      id: "t02",
      accountId: "acc_1",
      status: "pending",
      transactionDate: "2026-11-01",
      bookingDate: null,
      amountMinor: -41250,
      counterparty: "ICA Nära Sofo",
      description: "Kortköp",
      categoryId,
      categorySource: "template",
      isInternalTransfer: false,
      manualTransfer: null,
      split: false,
    });
    expect(items.find((t) => t.id === "t04")).toMatchObject({ isInternalTransfer: true });
    expect(items.find((t) => t.id === "t03")).toMatchObject({ split: true });
  });

  it("säger om användaren själv har valt att transaktionen inte räknas (KK-39)", async () => {
    await db.prepare(`UPDATE transactions SET manual_transfer = 1, is_internal_transfer = 1 WHERE id = 't02'`).run();
    const { items } = await transactionRepository(db).list(NOVEMBER);
    expect(items.find((t) => t.id === "t02")).toMatchObject({ isInternalTransfer: true, manualTransfer: true });
    await db.prepare(`UPDATE transactions SET manual_transfer = NULL, is_internal_transfer = 0 WHERE id = 't02'`).run();
  });

  it("filtrerar på okategoriserade och på en kategori, där en uppdelning med en del i kategorin räknas", async () => {
    expect(await ids({ uncategorized: true })).toEqual(["t07", "t05", "t04", "t03"]);
    expect(await ids({ categoryId })).toEqual(["t03", "t02"]);
  });

  it("en huvudkategori tar med sina underkategorier, så att budgetens utgifter går att se (KK-20)", async () => {
    const parent = (await db.prepare(`SELECT parent_id AS p FROM categories WHERE id = ?`).bind(categoryId).first<{ p: string }>())?.p ?? "";
    expect(await ids({ categoryId: parent })).toEqual(["t03", "t02"]);
    expect(await ids({ categoryId: "finns-inte" })).toEqual([]);
  });

  it("söker i motpart och beskrivning utan att bry sig om stora och små bokstäver", async () => {
    expect(await ids({ q: "ica nära" })).toEqual(["t02"]);
    expect(await ids({ q: "november" })).toEqual(["t04"]);
  });

  it("behandlar % och _ i sökningen som vanliga tecken", async () => {
    expect(await ids({ q: "50%" })).toEqual(["t05"]);
    expect(await ids({ q: "%" })).toEqual(["t05"]);
    expect(await ids({ q: "_" })).toEqual([]);
  });

  it("bläddrar sida för sida med cursor utan att tappa eller dubblera rader vid samma datum", async () => {
    const repo = transactionRepository(db);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const result = await repo.list({ ...NOVEMBER, limit: 2, cursor });
      seen.push(...result.items.map((t) => t.id));
      cursor = result.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toEqual(["t07", "t05", "t04", "t03", "t02"]);
  });

  it("ger ingen nästa cursor när sidan inte är full", async () => {
    expect((await transactionRepository(db).list({ ...NOVEMBER, limit: 5 })).nextCursor).toBeNull();
  });

  it.each(["inte-en-cursor", "eyJ4IjoxfQ", ""])("avvisar en ogiltig cursor (%j) med RangeError", async (cursor) => {
    await expect(transactionRepository(db).list({ ...NOVEMBER, cursor })).rejects.toThrow(RangeError);
  });
});

describe("perioden räknas som i budgeten (KK-20, KK-34)", () => {
  it("ett köp hör till perioden då det bokfördes, eller köptes om det inte är bokfört än", async () => {
    await db.batch([
      db.prepare(
        `INSERT INTO transactions (id, account_id, fingerprint, status, last_seen_at, transaction_date, booking_date, amount_minor, counterparty, counterparty_norm, description, category_source)
         VALUES ('b-okt', 'acc_1', 'fp', 'booked', '2026-11-01', '2026-10-31', '2026-11-01', -100, 'KÖPT I OKTOBER', 'KÖPT I OKTOBER', '', 'none'),
                ('b-dec', 'acc_1', 'fp', 'booked', '2026-12-01', '2026-11-30', '2026-12-01', -100, 'BOKAD I DECEMBER', 'BOKAD I DECEMBER', '', 'none')`,
      ),
    ]);
    const november = await ids();
    expect(november).toContain("b-okt");
    expect(november).not.toContain("b-dec");
    expect(await ids({ from: "2026-12-01", to: "2026-12-31" })).toContain("b-dec");
    await db.prepare(`DELETE FROM transactions WHERE id IN ('b-okt', 'b-dec')`).run();
  });
});
