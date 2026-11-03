import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { budgetOutcome, type BudgetTransaction } from "./budget.ts";
import { CATEGORY_TEMPLATE } from "./categories.ts";
import { leftToSpend, periodTotals, recentPeriods, totalBalance, trend } from "./overview.ts";
import { budgetPeriodForKey, type BudgetPeriod } from "./period.ts";
import type { SplitPart } from "./split.ts";

const NOVEMBER: BudgetPeriod = { key: "2026-11", start: "2026-11-01", end: "2026-11-30" };
const categories = CATEGORY_TEMPLATE;
let seq = 0;

function tx(overrides: Partial<BudgetTransaction>): BudgetTransaction {
  return { id: `t${String(++seq)}`, date: "2026-11-10", amountMinor: -10000, categoryId: "mat-livsmedel", status: "booked", internal: false, ...overrides };
}

const totals = (transactions: BudgetTransaction[], splits = new Map<string, SplitPart[]>()) =>
  periodTotals({ period: NOVEMBER, transactions, splits, categories });

describe("saldo (KK-17-A)", () => {
  it("summerar bara de konton som är valda i översikten", () => {
    expect(totalBalance([
      { balanceMinor: 1250050, included: true },
      { balanceMinor: -320000, included: true },
      { balanceMinor: 9999999, included: false },
    ])).toBe(930050);
  });

  it("ger noll utan konton och avvisar belopp som inte är heltal öre", () => {
    expect(totalBalance([])).toBe(0);
    expect(() => totalBalance([{ balanceMinor: 1.5, included: true }])).toThrow("Belopp måste vara ett heltal i öre");
  });
});

describe("periodens in, ut och netto (KK-17-A)", () => {
  it("lön och föräldrapenning är inkomst, köp är utgift", () => {
    const result = totals([
      tx({ amountMinor: 3000000, categoryId: "inkomst-lon" }),
      tx({ amountMinor: 450000, categoryId: "inkomst-foraldrapenning" }),
      tx({ amountMinor: -60000 }),
      tx({ amountMinor: -12500, status: "pending", categoryId: "transport-taxi" }),
    ]);
    expect(result).toEqual({ period: "2026-11", incomeMinor: 3450000, expenseMinor: 72500, netMinor: 3377500 });
  });

  it("en okategoriserad insättning räknas som inkomst och en okategoriserad utbetalning som utgift", () => {
    expect(totals([tx({ amountMinor: 2500000, categoryId: null }), tx({ amountMinor: -4000, categoryId: null })])).toMatchObject({
      incomeMinor: 2500000,
      expenseMinor: 4000,
    });
  });

  it("interna överföringar, kortfaktura och amortering är varken in eller ut (KK-20-C, KK-36-B)", () => {
    const result = totals([
      tx({ amountMinor: -500000, categoryId: null, internal: true }),
      tx({ amountMinor: 500000, categoryId: null, internal: true }),
      tx({ amountMinor: -400000, categoryId: "sparande-overforingar-amortering" }),
      tx({ amountMinor: -700000, categoryId: "boende-laneranta" }),
    ]);
    expect(result).toMatchObject({ incomeMinor: 0, expenseMinor: 700000, netMinor: -700000 });
  });

  it("borttagna och transaktioner utanför perioden räknas inte", () => {
    const result = totals([
      tx({ amountMinor: 100000, categoryId: "inkomst-lon", status: "removed" }),
      tx({ amountMinor: 100000, categoryId: "inkomst-lon", date: "2026-10-31" }),
      tx({ amountMinor: 100000, categoryId: "inkomst-lon", date: "2026-12-01" }),
    ]);
    expect(result).toMatchObject({ incomeMinor: 0, expenseMinor: 0 });
  });

  it("en uppdelad transaktion räknas per del", () => {
    const t = tx({ id: "delad", amountMinor: -11000 });
    const splits = new Map([["delad", [
      { categoryId: "boende-laneranta", amountMinor: -7000 },
      { categoryId: "sparande-overforingar-amortering", amountMinor: -4000 },
    ]]]);
    expect(totals([t], splits)).toMatchObject({ expenseMinor: 7000 });
  });

  it("utgiften är densamma som budgetens totala utfall", () => {
    const amount = fc.integer({ min: -1_000_000, max: 1_000_000 });
    const category = fc.constantFrom<string | null>(null, "mat-livsmedel", "inkomst-lon", "sparande-overforingar-sparande", "transport-taxi");
    const transaction = fc.record({ amountMinor: amount, categoryId: category, internal: fc.boolean(), status: fc.constantFrom("pending" as const, "booked" as const, "removed" as const) });
    fc.assert(
      fc.property(fc.array(transaction, { maxLength: 20 }), (overrides) => {
        const transactions = overrides.map((o) => tx(o));
        const input = { period: NOVEMBER, transactions, splits: new Map(), categories };
        const result = periodTotals(input);
        expect(result.expenseMinor).toBe(budgetOutcome({ ...input, lines: [] }).totalActualMinor);
        expect(result.netMinor).toBe(result.incomeMinor - result.expenseMinor);
      }),
    );
  });
});

describe("kvar att spendera (KK-17-B, V-u-overview)", () => {
  it("är budget minus utfall och delas på dagarna kvar, i dag inräknad", () => {
    expect(leftToSpend({ period: NOVEMBER, today: "2026-11-21", budgetMinor: 2500000, actualMinor: 1600000 })).toEqual({
      leftMinor: 900000,
      daysLeft: 10,
      perDayMinor: 90000,
      over: false,
    });
  });

  it("avrundar kvar per dag nedåt till helt öre", () => {
    expect(leftToSpend({ period: NOVEMBER, today: "2026-11-28", budgetMinor: 1000, actualMinor: 0 }).perDayMinor).toBe(333);
  });

  it("över budget ger negativt kvar och noll per dag", () => {
    expect(leftToSpend({ period: NOVEMBER, today: "2026-11-21", budgetMinor: 100000, actualMinor: 125000 })).toEqual({
      leftMinor: -25000,
      daysLeft: 10,
      perDayMinor: 0,
      over: true,
    });
  });

  it("sista dagen är en dag kvar, och efter perioden finns ingen dag kvar", () => {
    expect(leftToSpend({ period: NOVEMBER, today: "2026-11-30", budgetMinor: 5000, actualMinor: 0 })).toMatchObject({ daysLeft: 1, perDayMinor: 5000 });
    expect(leftToSpend({ period: NOVEMBER, today: "2026-12-01", budgetMinor: 5000, actualMinor: 0 })).toMatchObject({ daysLeft: 0, perDayMinor: null });
  });

  it("före perioden räknas hela perioden", () => {
    const period: BudgetPeriod = { key: "2026-11", start: "2026-10-23", end: "2026-11-24" };
    expect(leftToSpend({ period, today: "2026-10-01", budgetMinor: 3300, actualMinor: 0 })).toMatchObject({ daysLeft: 33, perDayMinor: 100 });
  });

  it("kvar per dag gånger dagarna överskrider aldrig det som är kvar", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000 }), fc.integer({ min: 0, max: 10_000_000 }), fc.integer({ min: 1, max: 30 }), (budgetMinor, actualMinor, day) => {
        const today = `2026-11-${String(day).padStart(2, "0")}`;
        const result = leftToSpend({ period: NOVEMBER, today, budgetMinor, actualMinor });
        const perDay = result.perDayMinor ?? 0;
        expect(perDay * result.daysLeft).toBeLessThanOrEqual(Math.max(0, result.leftMinor));
        if (result.leftMinor > 0) expect(result.leftMinor - perDay * result.daysLeft).toBeLessThan(result.daysLeft);
      }),
    );
  });
});

describe("trend de senaste 12 perioderna (KK-17-C)", () => {
  it("ger perioderna äldst först, till och med den aktuella, över ett årsskifte", () => {
    const periods = recentPeriods(budgetPeriodForKey("2026-02", 1), 1, 12);
    expect(periods.map((p) => p.key)).toEqual([
      "2025-03", "2025-04", "2025-05", "2025-06", "2025-07", "2025-08",
      "2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02",
    ]);
  });

  it("följer lönedagen: perioderna ligger kant i kant", () => {
    const periods = recentPeriods(budgetPeriodForKey("2026-11", 25), 25, 12);
    for (let i = 1; i < periods.length; i++) {
      const previousEnd = Date.parse(periods[i - 1]?.end ?? "");
      expect(Date.parse(periods[i]?.start ?? "") - previousEnd).toBe(86400000);
    }
  });

  it("avvisar ett antal under ett", () => {
    expect(() => recentPeriods(NOVEMBER, 1, 0)).toThrow("Antalet perioder måste vara minst 1");
  });

  it("räknar in, ut och netto per period", () => {
    const periods = recentPeriods(NOVEMBER, 1, 2);
    const result = trend({
      periods,
      transactions: [tx({ date: "2026-10-05", amountMinor: -2000 }), tx({ amountMinor: 50000, categoryId: "inkomst-lon" })],
      splits: new Map(),
      categories,
    });
    expect(result).toEqual([
      { period: "2026-10", incomeMinor: 0, expenseMinor: 2000, netMinor: -2000 },
      { period: "2026-11", incomeMinor: 50000, expenseMinor: 0, netMinor: 50000 },
    ]);
  });
});
