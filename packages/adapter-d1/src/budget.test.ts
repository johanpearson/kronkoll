import type { D1Database } from "@cloudflare/workers-types";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { budgetRepository } from "./budget.ts";
import { deriveKeys } from "./crypto.ts";
import { accountRepository, connectionRepository } from "./repositories.ts";
import { migratedDb, randomSecret } from "./test-support.ts";

let db: D1Database;
let dispose: () => Promise<void>;

beforeAll(async () => {
  ({ db, dispose } = await migratedDb());
  const keys = await deriveKeys(randomSecret());
  await connectionRepository(db, keys).create({ id: "c1", provider: "enablebanking", aspspName: "Skandia" });
  await accountRepository(db, keys).upsertFromBank({ connectionId: "c1", providerUid: "u1", iban: null, name: "Privatkonto", type: "checking", balanceMinor: 0 }, () => "acc_1");
});
afterAll(async () => {
  await dispose();
});

/** Påhittade transaktioner (KK-13) runt en period 1–30 november. */
beforeEach(async () => {
  await db.batch([db.prepare(`DELETE FROM budget_lines`), db.prepare(`DELETE FROM transactions`)]);
  const rows: [string, string, string | null, string, number, string | null, number][] = [
    ["okt", "2026-10-31", "2026-10-31", "booked", -1000, "mat-livsmedel", 0],
    ["bokas-nov", "2026-10-30", "2026-11-01", "booked", -2000, "mat-livsmedel", 0],
    ["prel", "2026-11-15", null, "pending", -3000, null, 0],
    ["intern", "2026-11-10", "2026-11-10", "booked", -500000, null, 1],
    ["delad", "2026-11-20", "2026-11-20", "booked", -124000, null, 0],
    ["borta", "2026-11-05", null, "removed", -9900, null, 0],
    ["dec", "2026-12-01", "2026-12-01", "booked", -5000, null, 0],
  ];
  await db.batch(
    rows.map(([id, date, booking, status, amount, category, internal]) =>
      db
        .prepare(
          `INSERT INTO transactions (id, account_id, fingerprint, status, last_seen_at, transaction_date, booking_date, amount_minor, category_id, category_source, is_internal_transfer)
           VALUES (?, 'acc_1', 'fp', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, status, date, date, booking, amount, category, category === null ? "none" : "template", internal),
    ),
  );
  await db.prepare(`INSERT INTO transaction_splits (id, transaction_id, category_id, amount_minor) VALUES ('s1', 'delad', 'hushall-forbrukning', -90000), ('s2', 'delad', 'fritid-hobby', -34000)`).run();
});

const NOVEMBER = { key: "2026-11", start: "2026-11-01", end: "2026-11-30" };

describe("budget i D1 (KK-20)", () => {
  it("ger periodens transaktioner med bokföringsdagen som datum, annars köpdagen, och utan borttagna", async () => {
    const { transactions } = await budgetRepository(db).actuals(NOVEMBER);
    expect(transactions.map((t) => t.id).sort()).toEqual(["bokas-nov", "delad", "intern", "prel"]);
    expect(transactions.find((t) => t.id === "bokas-nov")).toEqual({
      id: "bokas-nov",
      date: "2026-11-01",
      amountMinor: -2000,
      categoryId: "mat-livsmedel",
      status: "booked",
      internal: false,
    });
    expect(transactions.find((t) => t.id === "intern")).toMatchObject({ internal: true });
  });

  it("ger uppdelningarna för periodens transaktioner", async () => {
    const { splits } = await budgetRepository(db).actuals(NOVEMBER);
    expect([...splits]).toEqual([
      [
        "delad",
        [
          { categoryId: "hushall-forbrukning", amountMinor: -90000 },
          { categoryId: "fritid-hobby", amountMinor: -34000 },
        ],
      ],
    ]);
  });

  it("sparar budgetrader för en period och ersätter dem helt nästa gång", async () => {
    const repo = budgetRepository(db);
    await repo.replace("2026-11", [{ categoryId: "mat", amountMinor: 630000 }, { categoryId: "boende", amountMinor: 1200000 }], "manual");
    await repo.replace("2026-11", [{ categoryId: "mat", amountMinor: 600000 }], "copy_previous");
    expect(await repo.lines("2026-11")).toEqual([{ categoryId: "mat", amountMinor: 600000 }]);
    expect(await repo.lines("2026-10")).toEqual([]);
  });

  it("en okänd kategori eller ett negativt belopp rullar tillbaka hela ändringen", async () => {
    const repo = budgetRepository(db);
    await repo.replace("2026-11", [{ categoryId: "mat", amountMinor: 630000 }], "manual");
    await expect(repo.replace("2026-11", [{ categoryId: "finns-inte", amountMinor: 1 }], "manual")).rejects.toThrow();
    await expect(repo.replace("2026-11", [{ categoryId: "mat", amountMinor: -1 }], "manual")).rejects.toThrow();
    expect(await repo.lines("2026-11")).toEqual([{ categoryId: "mat", amountMinor: 630000 }]);
  });
});
