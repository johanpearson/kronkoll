import { describe, expect, it } from "vitest";
import type { BudgetTransaction } from "./budget.ts";
import { CATEGORY_TEMPLATE } from "./categories.ts";
import { spendingAnomalies, spendingByMainCategory, topExpenses } from "./insights.ts";
import type { BudgetPeriod } from "./period.ts";
import type { SplitPart } from "./split.ts";

const kr = (amount: number) => amount * 100;
const NOVEMBER: BudgetPeriod = { key: "2026-11", start: "2026-11-01", end: "2026-11-30" };
const categories = CATEGORY_TEMPLATE;
const id = (name: string, parent?: string): string =>
  (categories.find((c) => c.name === name && (parent === undefined ? c.parentId === null : c.parentId === id(parent))) ?? { id: "?" }).id;
const RESTAURANG = id("Restaurang & café", "Mat");
const LIVSMEDEL = id("Livsmedel", "Mat");
const KLADER_BARN = id("Kläder", "Barn");
const HYRA = id("Hyra & avgift", "Boende");
const SPARANDE = id("Sparande", "Sparande & överföringar");

let seq = 0;
/** Påhittade transaktioner (KK-13). */
function tx(amount: number, categoryId: string | null, extra: Partial<BudgetTransaction> = {}): BudgetTransaction {
  seq += 1;
  return { id: `t${String(seq)}`, date: "2026-11-10", amountMinor: kr(amount), categoryId, status: "booked", internal: false, ...extra };
}
const spending = (entries: readonly [string | null, number][]) => new Map(entries.map(([c, a]) => [c, kr(a)]));

describe("spendingAnomalies: avvikelser mot snittet av tidigare månader (KK-24-B)", () => {
  const history = [spending([[RESTAURANG, 2_400], [LIVSMEDEL, 6_000]]), spending([[RESTAURANG, 2_700], [LIVSMEDEL, 6_000]]), spending([[RESTAURANG, 2_610], [LIVSMEDEL, 6_000]])];

  it("visar en kategori som ligger mer än 30 % och minst 500 kr över snittet", () => {
    expect(spendingAnomalies(spending([[RESTAURANG, 3_750], [LIVSMEDEL, 6_200]]), history)).toEqual([
      { categoryId: RESTAURANG, actualMinor: kr(3_750), baselineMinor: kr(2_570), diffMinor: kr(1_180), pct: 46 },
    ]);
  });

  it("kräver både mer än 30 % och minst 500 kr", () => {
    const base = [spending([[RESTAURANG, 1_000]])];
    expect(spendingAnomalies(spending([[RESTAURANG, 1_500]]), base)).toHaveLength(1);
    expect(spendingAnomalies(spending([[RESTAURANG, 1_300]]), base)).toEqual([]);
    expect(spendingAnomalies(spending([[RESTAURANG, 1_499]]), [spending([[RESTAURANG, 1_000]])])).toEqual([]);
    expect(spendingAnomalies(spending([[RESTAURANG, 2_000]]), [spending([[RESTAURANG, 1_501]])])).toEqual([]);
    expect(spendingAnomalies(new Map([[RESTAURANG, kr(1_500)]]), [new Map([[RESTAURANG, kr(1_000) + 1]])])).toEqual([]);
    const big = [spending([[HYRA, 10_000]])];
    expect(spendingAnomalies(spending([[HYRA, 13_000]]), big)).toEqual([]);
    expect(spendingAnomalies(new Map([[HYRA, kr(13_000) + 1]]), big)).toHaveLength(1);
  });

  it("räknar en kategori som saknas en månad som noll och visar ny utgift utan procent", () => {
    const sparse = [spending([[KLADER_BARN, 1_530]]), spending([]), spending([[KLADER_BARN, 1_530]])];
    expect(spendingAnomalies(spending([[KLADER_BARN, 2_140], [RESTAURANG, 500], [LIVSMEDEL, 499]]), sparse)).toEqual([
      { categoryId: KLADER_BARN, actualMinor: kr(2_140), baselineMinor: kr(1_020), diffMinor: kr(1_120), pct: 110 },
      { categoryId: RESTAURANG, actualMinor: kr(500), baselineMinor: 0, diffMinor: kr(500), pct: null },
    ]);
  });

  it("sorterar största ökningen först och hoppar över okategoriserat, minskningar och tom historik", () => {
    const base = [spending([[RESTAURANG, 1_000], [LIVSMEDEL, 1_000], [null, 100], [HYRA, 9_000]])];
    const result = spendingAnomalies(spending([[RESTAURANG, 1_600], [LIVSMEDEL, 3_000], [null, 5_000], [HYRA, 1_000]]), base);
    expect(result.map((a) => a.categoryId)).toEqual([LIVSMEDEL, RESTAURANG]);
    expect(spendingAnomalies(spending([[RESTAURANG, 9_000]]), [])).toEqual([]);
  });

  it("avrundar snitt och procent till hela ören och procent", () => {
    const base = [new Map([[RESTAURANG, 100_000]]), new Map([[RESTAURANG, 100_001]]), new Map([[RESTAURANG, 100_001]])];
    expect(spendingAnomalies(new Map([[RESTAURANG, 200_000]]), base)[0]).toMatchObject({ baselineMinor: 100_001, diffMinor: 99_999, pct: 100 });
  });
});

describe("topExpenses: största utgifterna i perioden (KK-24-C)", () => {
  it("visar de fem största utbetalningarna med kategori, störst först", () => {
    const list = [tx(-1_482, LIVSMEDEL), tx(-8_900, HYRA), tx(-640, LIVSMEDEL), tx(-1_060, null), tx(-99, LIVSMEDEL), tx(-700, RESTAURANG)];
    const result = topExpenses({ period: NOVEMBER, transactions: list, splits: new Map(), categories });
    expect(result.map((r) => [r.amountMinor, r.categoryId, r.split])).toEqual([
      [kr(8_900), HYRA, false], [kr(1_482), LIVSMEDEL, false], [kr(1_060), null, false], [kr(700), RESTAURANG, false], [kr(640), LIVSMEDEL, false],
    ]);
    expect(result[0]).toEqual({ id: list[1]?.id, date: "2026-11-10", amountMinor: kr(8_900), categoryId: HYRA, split: false });
  });

  it("räknar en uppdelad transaktion med den största delens kategori och bara utgiftsdelarna", () => {
    const split = tx(-1_240, null);
    const parts: SplitPart[] = [{ categoryId: LIVSMEDEL, amountMinor: kr(-300) }, { categoryId: KLADER_BARN, amountMinor: kr(-540) }, { categoryId: SPARANDE, amountMinor: kr(-400) }];
    const result = topExpenses({ period: NOVEMBER, transactions: [split], splits: new Map([[split.id, parts]]), categories });
    expect(result).toEqual([{ id: split.id, date: "2026-11-10", amountMinor: kr(840), categoryId: KLADER_BARN, split: true }]);
  });

  it("räknar inte inkomster, interna, borttagna, andra perioder eller överföringskategorier", () => {
    const skipped = [tx(5_000, LIVSMEDEL), tx(-900, LIVSMEDEL, { internal: true }), tx(-900, LIVSMEDEL, { status: "removed" }), tx(-900, LIVSMEDEL, { date: "2026-10-31" }), tx(-900, SPARANDE)];
    expect(topExpenses({ period: NOVEMBER, transactions: skipped, splits: new Map(), categories })).toEqual([]);
    expect(topExpenses({ period: NOVEMBER, transactions: [tx(-1, LIVSMEDEL, { status: "pending" })], splits: new Map(), categories })).toHaveLength(1);
  });

  it("tar bara med det antal som efterfrågas och bryter lika belopp på datum, nyast först", () => {
    const a = tx(-500, LIVSMEDEL, { date: "2026-11-02" });
    const b = tx(-500, LIVSMEDEL, { date: "2026-11-20" });
    const result = topExpenses({ period: NOVEMBER, transactions: [a, b, tx(-100, LIVSMEDEL)], splits: new Map(), categories }, 2);
    expect(result.map((r) => r.id)).toEqual([b.id, a.id]);
  });
});

describe("spendingByMainCategory: utgifter per huvudkategori (KK-24-C)", () => {
  it("summerar underkategorier i sin huvudkategori, störst först, med okategoriserat för sig", () => {
    const list = [tx(-1_482, LIVSMEDEL), tx(-700, RESTAURANG), tx(-8_900, HYRA), tx(-300, null), tx(-200, id("Mat")), tx(100, RESTAURANG)];
    expect(spendingByMainCategory({ period: NOVEMBER, transactions: list, splits: new Map(), categories })).toEqual([
      { categoryId: id("Boende"), amountMinor: kr(8_900) },
      { categoryId: id("Mat"), amountMinor: kr(2_282) },
      { categoryId: null, amountMinor: kr(300) },
    ]);
  });

  it("hoppar över kategorier där återbetalningar tar ut utgifterna, och okänd kategori står för sig", () => {
    const list = [tx(-500, RESTAURANG), tx(500, RESTAURANG), tx(-50, "okand"), tx(-50, HYRA), tx(-50, null)];
    expect(spendingByMainCategory({ period: NOVEMBER, transactions: list, splits: new Map(), categories })).toEqual([
      { categoryId: null, amountMinor: kr(50) },
      { categoryId: id("Boende"), amountMinor: kr(50) },
      { categoryId: "okand", amountMinor: kr(50) },
    ]);
  });
});
