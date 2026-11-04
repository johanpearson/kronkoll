import type { D1Database } from "@cloudflare/workers-types";
import { INCOME_TEMPLATE_RULES, applyIncomeRules } from "@kronkoll/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { incomeRepository } from "./income.ts";
import { migratedDb } from "./test-support.ts";

let db: D1Database;
let dispose: () => Promise<void>;

beforeAll(async () => {
  ({ db, dispose } = await migratedDb());
});
afterAll(async () => {
  await dispose();
});

/** Påhittade transaktioner (KK-13). Skandia skickar ingen motpart, så texten står i description. */
beforeEach(async () => {
  await db.batch([
    db.prepare(`DELETE FROM bank_connections`),
    db.prepare(`DELETE FROM category_rules WHERE source = 'learned'`),
    db.prepare(`INSERT INTO bank_connections (id, provider, status) VALUES ('c1', 'enablebanking', 'active')`),
    db.prepare(`INSERT INTO accounts (id, connection_id, display_name, type) VALUES ('a1', 'c1', 'Privatkonto', 'checking')`),
  ]);
});

interface Tx {
  id: string;
  amount: number;
  description?: string;
  status?: string;
  date?: string;
  booking?: string | null;
  internal?: boolean;
}

async function insert(...rows: Tx[]) {
  await db.batch(
    rows.map((t) =>
      db
        .prepare(
          `INSERT INTO transactions (id, account_id, fingerprint, status, last_seen_at, transaction_date, booking_date, amount_minor, description, is_internal_transfer)
           VALUES (?, 'a1', 'fp', ?, '2026-11-01T06:00:00Z', ?, ?, ?, ?, ?)`,
        )
        .bind(t.id, t.status ?? "booked", t.date ?? "2026-10-25", t.booking ?? null, t.amount, t.description ?? "", t.internal ? 1 : 0),
    ),
  );
}

describe("inkomstregler i D1 (KK-22-A)", () => {
  it("ger mallreglerna, och inga kategoriregler eller regler som domänen inte kan använda", async () => {
    await db.prepare(`INSERT INTO category_rules (id, match, pattern, income_type, source) VALUES ('belopp', 'amount_range', '100-200', 'other', 'learned')`).run();
    expect(await incomeRepository(db).rules()).toEqual(INCOME_TEMPLATE_RULES);
  });

  it("sparar en inlärd regel och uppdaterar dess typ", async () => {
    const repo = incomeRepository(db);
    const rule = { id: "i1", match: "counterparty_prefix", pattern: "ACME AB", incomeType: "salary", source: "learned" } as const;
    await repo.saveRule(rule);
    await repo.saveRule({ ...rule, incomeType: "other" });
    expect((await repo.rules()).filter((r) => r.source === "learned")).toEqual([{ ...rule, incomeType: "other" }]);
  });
});

describe("klassning av transaktioner i D1 (KK-22-A)", () => {
  it("ger bara inbetalningar som inte är borttagna, oklassade som none", async () => {
    await insert(
      { id: "fk", amount: 2_000_000, description: "FÖRSÄKRINGSKASSAN" },
      { id: "ut", amount: -5_000 },
      { id: "bort", amount: 100, status: "removed" },
    );
    expect(await incomeRepository(db).incoming()).toEqual([
      { id: "fk", amountMinor: 2_000_000, counterpartyNorm: "", description: "FÖRSÄKRINGSKASSAN", incomeType: null, incomeSource: "none" },
    ]);
  });

  it("sparar klassningar, och en regel skriver aldrig över en manuell klassning", async () => {
    const repo = incomeRepository(db);
    await insert({ id: "fk", amount: 2_000_000, description: "FÖRSÄKRINGSKASSAN" }, { id: "lon", amount: 3_000_000, description: "ACME AB" });
    await repo.setIncome(applyIncomeRules(await repo.incoming(), await repo.rules()));
    await repo.setIncome([{ id: "lon", incomeType: "salary", incomeSource: "manual" }]);
    await repo.setIncome([{ id: "lon", incomeType: "other", incomeSource: "learned" }]);
    expect((await repo.incoming()).map((t) => [t.id, t.incomeType, t.incomeSource])).toEqual([
      ["fk", "parental_benefit", "template"],
      ["lon", "salary", "manual"],
    ]);
    await repo.setIncome([{ id: "lon", incomeType: "other", incomeSource: "manual" }]);
    expect((await repo.incoming()).find((t) => t.id === "lon")?.incomeType).toBe("other");
    await repo.setIncome([]);
  });
});

describe("inkomst per månad (KK-22-B)", () => {
  it("summerar per kalendermånad och typ, oklassat som övrigt, utan interna överföringar och borttagna", async () => {
    const repo = incomeRepository(db);
    await insert(
      { id: "lon-okt", amount: 3_000_000, date: "2026-10-24", booking: "2026-10-25" },
      { id: "fk-okt", amount: 500_000, date: "2026-10-10" },
      { id: "swish-okt", amount: 20_000, date: "2026-10-11" },
      { id: "oklassad-okt", amount: 1_000, date: "2026-10-12" },
      { id: "lon-nov", amount: 3_100_000, date: "2026-10-31", booking: "2026-11-02" },
      { id: "intern", amount: 900_000, date: "2026-10-15", internal: true },
      { id: "bort", amount: 900_000, date: "2026-10-15", status: "removed" },
      { id: "utgift", amount: -900_000, date: "2026-10-15" },
      { id: "sept", amount: 100, date: "2026-09-30" },
      { id: "dec", amount: 100, date: "2026-12-01" },
    );
    await repo.setIncome([
      { id: "lon-okt", incomeType: "salary", incomeSource: "template" },
      { id: "lon-nov", incomeType: "salary", incomeSource: "template" },
      { id: "fk-okt", incomeType: "parental_benefit", incomeSource: "template" },
      { id: "swish-okt", incomeType: "other", incomeSource: "none" },
    ]);
    expect(await repo.monthly("2026-10", "2026-11")).toEqual([
      { month: "2026-10", salaryMinor: 3_000_000, parentalBenefitMinor: 500_000, otherMinor: 21_000 },
      { month: "2026-11", salaryMinor: 3_100_000, parentalBenefitMinor: 0, otherMinor: 0 },
    ]);
  });
});
