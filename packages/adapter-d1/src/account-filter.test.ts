import type { D1Database } from "@cloudflare/workers-types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { budgetRepository } from "./budget.ts";
import { deriveKeys } from "./crypto.ts";
import { insightsRepository } from "./insights.ts";
import { accountRepository, connectionRepository } from "./repositories.ts";
import { migratedDb, randomSecret } from "./test-support.ts";
import { transactionRepository } from "./transactions.ts";

let db: D1Database;
let dispose: () => Promise<void>;

const NOVEMBER = { key: "2026-11", start: "2026-11-01", end: "2026-11-30" };

/** Påhittade konton och transaktioner (KK-13): en utgift per konto, och en uppdelad på det andra kontot. */
beforeAll(async () => {
  ({ db, dispose } = await migratedDb());
  const keys = await deriveKeys(randomSecret());
  await connectionRepository(db, keys).create({ id: "c1", provider: "enablebanking", aspspName: "Skandia" });
  const accounts = accountRepository(db, keys);
  await accounts.upsertFromBank({ connectionId: "c1", providerUid: "u1", iban: null, name: "Gemensamt", type: "checking", balanceMinor: 0 }, () => "acc_a");
  await accounts.upsertFromBank({ connectionId: "c1", providerUid: "u2", iban: null, name: "Privat", type: "checking", balanceMinor: 0 }, () => "acc_b");
  const rows: [string, string, number][] = [
    ["a1", "acc_a", -2000],
    ["b1", "acc_b", -7000],
    ["b2", "acc_b", -500],
  ];
  await db.batch(
    rows.map(([id, account, amount]) =>
      db
        .prepare(
          `INSERT INTO transactions (id, account_id, fingerprint, status, last_seen_at, transaction_date, booking_date, amount_minor, category_source, is_internal_transfer)
           VALUES (?, ?, 'fp', 'booked', '2026-11-05', '2026-11-05', '2026-11-05', ?, 'none', 0)`,
        )
        .bind(id, account, amount),
    ),
  );
  await db.prepare(`INSERT INTO transaction_splits (id, transaction_id, category_id, amount_minor) VALUES ('s1', 'b1', 'hushall-forbrukning', -7000)`).run();
});
afterAll(async () => {
  await dispose();
});

const FROM_TO = { from: "2026-11-01", to: "2026-11-30", limit: 50 };
const listed = async (accountIds?: string[]) => (await transactionRepository(db).list({ ...FROM_TO, accountIds })).items.map((t) => t.id).sort();

describe("kontofilter (KK-41-C)", () => {
  it("Transaktioner: utan filter visas alla konton, med filter bara de valda", async () => {
    expect(await listed()).toEqual(["a1", "b1", "b2"]);
    expect(await listed(["acc_a"])).toEqual(["a1"]);
    expect(await listed(["acc_b"])).toEqual(["b1", "b2"]);
    expect(await listed(["acc_a", "acc_b"])).toEqual(["a1", "b1", "b2"]);
    expect(await listed(["finns-inte"])).toEqual([]);
  });

  it("Budget: utfallet och uppdelningarna följer filtret", async () => {
    const repo = budgetRepository(db);
    const all = await repo.actuals(NOVEMBER);
    expect(all.transactions.map((t) => t.id).sort()).toEqual(["a1", "b1", "b2"]);
    expect(all.splits.has("b1")).toBe(true);
    const onlyA = await repo.actuals(NOVEMBER, ["acc_a"]);
    expect(onlyA.transactions.map((t) => t.id)).toEqual(["a1"]);
    expect(onlyA.splits.size).toBe(0);
    expect((await repo.actuals(NOVEMBER, ["acc_b"])).splits.has("b1")).toBe(true);
  });

  it("Insikter: utbetalningarna följer filtret", async () => {
    const repo = insightsRepository(db);
    expect((await repo.charges("2026-11-01", "2026-11-30")).map((c) => c.id).sort()).toEqual(["a1", "b1", "b2"]);
    expect((await repo.charges("2026-11-01", "2026-11-30", ["acc_b"])).map((c) => c.id).sort()).toEqual(["b1", "b2"]);
  });
});
