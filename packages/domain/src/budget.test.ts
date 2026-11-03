import { describe, expect, it } from "vitest";
import { budgetByMainCategory, budgetOutcome, spendingByCategory, suggestFromAverage, suggestFromPrevious, type BudgetTransaction } from "./budget.ts";
import { CATEGORY_TEMPLATE } from "./categories.ts";
import type { BudgetPeriod } from "./period.ts";
import type { SplitPart } from "./split.ts";

const NOVEMBER: BudgetPeriod = { key: "2026-11", start: "2026-11-01", end: "2026-11-30" };
const categories = CATEGORY_TEMPLATE;
let seq = 0;

function tx(overrides: Partial<BudgetTransaction>): BudgetTransaction {
  return { id: `t${String(++seq)}`, date: "2026-11-10", amountMinor: -10000, categoryId: "mat-livsmedel", status: "booked", internal: false, ...overrides };
}

function outcome(transactions: BudgetTransaction[], lines: { categoryId: string; amountMinor: number }[], splits = new Map<string, SplitPart[]>()) {
  return budgetOutcome({ period: NOVEMBER, transactions, splits, categories, lines });
}

describe("budgetutfall per kategori (KK-20-B, V-u-budget)", () => {
  it("visar budget, utfall, kvar och andel", () => {
    const result = outcome([tx({ amountMinor: -40000 }), tx({ amountMinor: -15000 })], [{ categoryId: "mat-livsmedel", amountMinor: 100000 }]);
    expect(result.lines).toEqual([
      { categoryId: "mat-livsmedel", budgetMinor: 100000, actualMinor: 55000, remainingMinor: 45000, percent: 55, over: false },
    ]);
  });

  it("markerar över 100 % och visar negativt kvar", () => {
    const [line] = outcome([tx({ amountMinor: -65520 })], [{ categoryId: "mat-livsmedel", amountMinor: 63000 }]).lines;
    expect(line).toMatchObject({ actualMinor: 65520, remainingMinor: -2520, percent: 104, over: true });
  });

  it("exakt 100 % är inte över", () => {
    expect(outcome([tx({ amountMinor: -63000 })], [{ categoryId: "mat-livsmedel", amountMinor: 63000 }]).lines[0]?.over).toBe(false);
  });

  it("en budget på noll ger ingen andel men markeras som över om något spenderats", () => {
    expect(outcome([tx({ amountMinor: -100 })], [{ categoryId: "mat-livsmedel", amountMinor: 0 }]).lines[0]).toMatchObject({ percent: null, over: true });
  });

  it("räknar preliminära men inte borttagna (D-pending, KK-9-C)", () => {
    const result = outcome(
      [tx({ amountMinor: -1000, status: "pending" }), tx({ amountMinor: -2000, status: "removed" })],
      [{ categoryId: "mat-livsmedel", amountMinor: 10000 }],
    );
    expect(result.lines[0]?.actualMinor).toBe(1000);
  });

  it("räknar bara transaktioner inom perioden (KK-33-A)", () => {
    const result = outcome(
      [tx({ date: "2026-10-31", amountMinor: -1000 }), tx({ date: "2026-12-01", amountMinor: -2000 }), tx({ date: "2026-11-30", amountMinor: -300 })],
      [{ categoryId: "mat-livsmedel", amountMinor: 10000 }],
    );
    expect(result.lines[0]?.actualMinor).toBe(300);
  });

  it("en återbetalning minskar utfallet", () => {
    expect(outcome([tx({ amountMinor: -5000 }), tx({ amountMinor: 1500 })], [{ categoryId: "mat-livsmedel", amountMinor: 10000 }]).lines[0]?.actualMinor).toBe(3500);
  });
});

describe("det som inte räknas som utgift (KK-20-C)", () => {
  it("interna överföringar och kortfakturan räknas inte, men redovisas separat", () => {
    const result = outcome(
      [tx({ amountMinor: -500000, categoryId: null, internal: true }), tx({ amountMinor: 500000, categoryId: null, internal: true }), tx({ amountMinor: -1000 })],
      [],
    );
    expect(result.totalActualMinor).toBe(1000);
    expect(result.excludedInternalMinor).toBe(500000);
  });

  it("amortering och andra överföringskategorier räknas inte, och inte heller inkomster", () => {
    const result = outcome(
      [tx({ amountMinor: -400000, categoryId: "sparande-overforingar-amortering" }), tx({ amountMinor: 4000000, categoryId: "inkomst-lon" }), tx({ amountMinor: -700000, categoryId: "boende-laneranta" })],
      [],
    );
    expect(result.totalActualMinor).toBe(700000);
  });
});

describe("uppdelade transaktioner (KK-19-A)", () => {
  it("räknas i varje dels kategori", () => {
    const split = tx({ amountMinor: -124000, categoryId: "ovrigt-ovrigt" });
    const splits = new Map([[split.id, [{ categoryId: "hushall-forbrukning", amountMinor: -90000 }, { categoryId: "fritid-hobby", amountMinor: -34000 }]]]);
    const result = outcome([split], [{ categoryId: "hushall-forbrukning", amountMinor: 100000 }, { categoryId: "fritid-hobby", amountMinor: 50000 }], splits);
    expect(result.lines.map((l) => [l.categoryId, l.actualMinor])).toEqual([
      ["hushall-forbrukning", 90000],
      ["fritid-hobby", 34000],
    ]);
  });
});

describe("budget på huvud- eller underkategori (KK-20-A)", () => {
  it("en budget på huvudkategorin täcker underkategorier utan egen budget, utan dubbelräkning", () => {
    const result = outcome(
      [tx({ amountMinor: -10000, categoryId: "mat-livsmedel" }), tx({ amountMinor: -3000, categoryId: "mat-restaurang-cafe" }), tx({ amountMinor: -500, categoryId: "mat" })],
      [{ categoryId: "mat", amountMinor: 20000 }, { categoryId: "mat-restaurang-cafe", amountMinor: 5000 }],
    );
    expect(result.lines.map((l) => [l.categoryId, l.actualMinor])).toEqual([
      ["mat", 10500],
      ["mat-restaurang-cafe", 3000],
    ]);
    expect(result.totalActualMinor).toBe(13500);
    expect(result.unbudgetedMinor).toBe(0);
  });

  it("en okategoriserad insättning minskar inte utgifterna, men en återbetalning i en utgiftskategori gör det", () => {
    const result = outcome(
      [tx({ amountMinor: -3000, categoryId: null }), tx({ amountMinor: 2500000, categoryId: null }), tx({ amountMinor: -10000 }), tx({ amountMinor: 4000 })],
      [{ categoryId: "mat-livsmedel", amountMinor: 10000 }],
    );
    expect(result).toMatchObject({ unbudgetedMinor: 3000, totalActualMinor: 9000 });
    expect(result.lines[0]?.actualMinor).toBe(6000);
  });

  it("utgifter utan budget och okategoriserade utgifter syns som ej budgeterat", () => {
    const result = outcome([tx({ amountMinor: -1000, categoryId: "transport-taxi" }), tx({ amountMinor: -2000, categoryId: null })], [{ categoryId: "mat", amountMinor: 1000 }]);
    expect(result.unbudgetedMinor).toBe(3000);
    expect(result.totalBudgetMinor).toBe(1000);
  });

  it.each([
    ["okänd kategori", [{ categoryId: "finns-inte", amountMinor: 100 }], "Okänd kategori i budgeten: finns-inte"],
    ["en inkomstkategori", [{ categoryId: "inkomst-lon", amountMinor: 100 }], "Budget kan bara sättas på utgiftskategorier"],
    ["ett negativt belopp", [{ categoryId: "mat", amountMinor: -100 }], "Budgeten kan inte vara negativ"],
    ["samma kategori två gånger", [{ categoryId: "mat", amountMinor: 100 }, { categoryId: "mat", amountMinor: 200 }], "Kategorin finns två gånger i budgeten: mat"],
  ])("avvisar en budgetrad med %s", (_, lines, message) => {
    expect(() => outcome([], lines)).toThrow(message);
  });
});

describe("budgetförslag (KK-20-A)", () => {
  it("kopierar föregående period", () => {
    const previous = [{ categoryId: "mat", amountMinor: 630000 }];
    expect(suggestFromPrevious(previous)).toEqual(previous);
    expect(suggestFromPrevious(previous)).not.toBe(previous);
  });

  it("föreslår snittet av de tre senaste perioderna, avrundat uppåt till hela tior", () => {
    const history = [
      new Map([["mat", 600000], ["transport", 50000]]),
      new Map([["mat", 650000]]),
      new Map([["mat", 700100], ["transport", 10000]]),
    ];
    expect(suggestFromAverage(history)).toEqual([
      { categoryId: "mat", amountMinor: 651000 },
      { categoryId: "transport", amountMinor: 20000 },
    ]);
  });

  it("utan historik blir förslaget tomt, och negativa snitt (fler återbetalningar) blir inte budget", () => {
    expect(suggestFromAverage([])).toEqual([]);
    expect(suggestFromAverage([new Map([["mat", -500]])])).toEqual([]);
  });

  it("utgifter per kategori kan räknas för en tidigare period, som underlag till snittet", () => {
    const spend = spendingByCategory({ period: NOVEMBER, transactions: [tx({ amountMinor: -1200 }), tx({ amountMinor: -300, categoryId: null })], splits: new Map(), categories });
    expect([...spend]).toEqual([["mat-livsmedel", 1200], [null, 300]]);
  });
});

describe("budget per huvudkategori, med underkategorier summerade uppåt (KK-20-A, KK-20-B)", () => {
  const groups = (transactions: BudgetTransaction[], lines: { categoryId: string; amountMinor: number }[], splits = new Map<string, SplitPart[]>()) =>
    budgetByMainCategory({ period: NOVEMBER, transactions, splits, categories, lines });

  it("summerar utgifterna i underkategorierna till huvudkategorin, med budget bara på huvudkategorin", () => {
    const result = groups(
      [tx({ categoryId: "mat-livsmedel", amountMinor: -40000 }), tx({ categoryId: "mat-restaurang-cafe", amountMinor: -25000 }), tx({ categoryId: "mat", amountMinor: -5000 })],
      [{ categoryId: "mat", amountMinor: 60000 }],
    );
    expect(result.groups).toEqual([
      {
        categoryId: "mat",
        budgetMinor: 60000,
        actualMinor: 70000,
        remainingMinor: -10000,
        percent: 117,
        over: true,
        subcategories: [
          { categoryId: "mat-livsmedel", budgetMinor: null, actualMinor: 40000, remainingMinor: null, percent: null, over: false },
          { categoryId: "mat-restaurang-cafe", budgetMinor: null, actualMinor: 25000, remainingMinor: null, percent: null, over: false },
        ],
      },
    ]);
    expect(result).toMatchObject({ totalBudgetMinor: 60000, totalActualMinor: 70000, uncategorizedMinor: 0 });
  });

  it("utan budget på huvudkategorin blir dess budget summan av underkategoriernas", () => {
    const [mat] = groups([tx({ categoryId: "mat-livsmedel", amountMinor: -40000 })], [
      { categoryId: "mat-livsmedel", amountMinor: 30000 },
      { categoryId: "mat-restaurang-cafe", amountMinor: 10000 },
    ]).groups;
    expect(mat).toMatchObject({ categoryId: "mat", budgetMinor: 40000, actualMinor: 40000, percent: 100, over: false });
    expect(mat?.subcategories).toEqual([
      { categoryId: "mat-livsmedel", budgetMinor: 30000, actualMinor: 40000, remainingMinor: -10000, percent: 133, over: true },
      { categoryId: "mat-restaurang-cafe", budgetMinor: 10000, actualMinor: 0, remainingMinor: 10000, percent: 0, over: false },
    ]);
  });

  it("med budget både på huvud- och underkategorier är huvudkategorins belopp taket, och totalen räknas bara en gång", () => {
    const result = groups([tx({ categoryId: "mat-livsmedel", amountMinor: -10000 })], [
      { categoryId: "mat", amountMinor: 60000 },
      { categoryId: "mat-livsmedel", amountMinor: 50000 },
    ]);
    expect(result.groups[0]).toMatchObject({ budgetMinor: 60000, actualMinor: 10000 });
    expect(result.totalBudgetMinor).toBe(60000);
  });

  it("huvudkategorier med utgifter men utan budget visas, och okategoriserat räknas för sig", () => {
    const result = groups(
      [tx({ categoryId: "transport-kollektivtrafik", amountMinor: -9000 }), tx({ categoryId: null, amountMinor: -3000 }), tx({ categoryId: "mat-livsmedel", amountMinor: -1000 })],
      [{ categoryId: "mat", amountMinor: 50000 }],
    );
    expect(result.groups.map((g) => [g.categoryId, g.budgetMinor, g.actualMinor])).toEqual([
      ["mat", 50000, 1000],
      ["transport", null, 9000],
    ]);
    expect(result.groups[1]).toMatchObject({ remainingMinor: null, percent: null, over: false });
    expect(result).toMatchObject({ uncategorizedMinor: 3000, totalActualMinor: 13000, totalBudgetMinor: 50000 });
  });

  it("räknar uppdelade transaktioner per del, och inte interna överföringar eller inkomster", () => {
    const delad = tx({ id: "delad", categoryId: null, amountMinor: -30000 });
    const result = groups(
      [delad, tx({ categoryId: "mat-livsmedel", amountMinor: -500000, internal: true }), tx({ categoryId: "inkomst-lon", amountMinor: 2500000 })],
      [],
      new Map([["delad", [{ categoryId: "mat-livsmedel", amountMinor: -20000 }, { categoryId: "transport-kollektivtrafik", amountMinor: -10000 }]]]),
    );
    expect(result.groups.map((g) => [g.categoryId, g.actualMinor])).toEqual([
      ["mat", 20000],
      ["transport", 10000],
    ]);
    expect(result.excludedInternalMinor).toBe(500000);
  });

  it("utan budget och utgifter blir det inga grupper", () => {
    expect(groups([], []).groups).toEqual([]);
  });
});
