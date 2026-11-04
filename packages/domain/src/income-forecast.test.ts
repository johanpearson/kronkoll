import { describe, expect, it } from "vitest";
import {
  compareWithNormal,
  dailyBenefitMinor,
  estimateLeaveIncome,
  parametersFor,
  withdrawalDays,
  type IncomeParameters,
  type LeavePeriod,
} from "./income-forecast.ts";

// Påhittade parametrar i samma form som Försäkringskassans (antagande A-5).
const p2026: IncomeParameters = { year: 2026, priceBaseAmountMinor: 5_920_000, sgiCapMultiplier: 10, benefitRate: 0.8, sgiFactor: 0.97 };
const p2027: IncomeParameters = { ...p2026, year: 2027, priceBaseAmountMinor: 6_000_000 };

const leave: LeavePeriod = {
  from: "2027-03-01",
  to: "2027-08-31",
  daysPerWeek: 5,
  sgiAnnualMinor: 54_000_000,
  employerTopupPct: 10,
  taxRatePct: 31.5,
  overrideNetMonthlyMinor: null,
};

describe("dagbelopp (KK-23-A, V-u-forecast)", () => {
  it("SGI 540 000 kr ger ≈ 1 148 kr per dag, avrundat till hela kronor", () => {
    expect(dailyBenefitMinor(54_000_000, p2027)).toBe(114_800);
  });

  it("taket gäller: SGI över 10 prisbasbelopp räknas som taket", () => {
    // 10 × 60 000 kr × 0,97 × 0,80 / 365 = 1 275,6 kr
    expect(dailyBenefitMinor(90_000_000, p2027)).toBe(127_600);
    expect(dailyBenefitMinor(60_000_000, p2027)).toBe(127_600);
  });

  it("parametrarna styr beräkningen och hårdkodas inte", () => {
    expect(dailyBenefitMinor(36_500_000, { ...p2027, benefitRate: 0.5, sgiFactor: 1 })).toBe(50_000);
  });

  it("noll i SGI ger noll, negativ SGI är ett fel", () => {
    expect(dailyBenefitMinor(0, p2027)).toBe(0);
    expect(() => dailyBenefitMinor(-1, p2027)).toThrow("SGI kan inte vara negativ");
  });
});

describe("årsparametrar", () => {
  it("använder årets parametrar", () => {
    expect(parametersFor(2026, [p2027, p2026])).toEqual({ parameters: p2026, fallback: false });
  });

  it("saknas året används senaste året med en varning", () => {
    expect(parametersFor(2028, [p2026, p2027])).toEqual({ parameters: p2027, fallback: true });
    expect(parametersFor(2025, [p2027, p2026])).toEqual({ parameters: p2027, fallback: true });
  });

  it("utan parametrar går det inte att uppskatta", () => {
    expect(() => parametersFor(2027, [])).toThrow("Årsparametrar saknas");
  });
});

describe("uttagsdagar", () => {
  it("5 dagar per vecka är måndag till fredag", () => {
    // Mars 2027 börjar på en måndag och har 23 vardagar.
    expect(withdrawalDays("2027-03-01", "2027-03-31", 5)).toBe(23);
    expect(withdrawalDays("2027-03-06", "2027-03-07", 5)).toBe(0);
  });

  it("7 dagar per vecka är alla dagar, 0 är inga", () => {
    expect(withdrawalDays("2027-03-01", "2027-03-31", 7)).toBe(31);
    expect(withdrawalDays("2027-03-01", "2027-03-31", 0)).toBe(0);
  });

  it("6 dagar per vecka är måndag till lördag", () => {
    expect(withdrawalDays("2027-03-01", "2027-03-07", 6)).toBe(6);
  });

  it("halva dagar räknas: 2,5 dagar är måndag, tisdag och en halv onsdag", () => {
    expect(withdrawalDays("2027-03-01", "2027-03-07", 2.5)).toBe(2.5);
    expect(withdrawalDays("2027-03-03", "2027-03-03", 2.5)).toBe(0.5);
  });
});

describe("uppskattad nettoinkomst per månad (KK-23-A)", () => {
  it("ger en rad per månad i perioden", () => {
    expect(estimateLeaveIncome(leave, [p2027]).map((m) => m.month)).toEqual([
      "2027-03",
      "2027-04",
      "2027-05",
      "2027-06",
      "2027-07",
      "2027-08",
    ]);
  });

  it("hel månad: föräldrapenning per uttagsdag plus föräldralön, minus skatt", () => {
    const [march] = estimateLeaveIncome(leave, [p2027]);
    // 23 × 1 148 kr + 10 % av 45 000 kr = 30 904 kr; × (1 − 0,315) = 21 169,24 kr
    expect(march).toEqual({
      month: "2027-03",
      leaveDays: 31,
      daysInMonth: 31,
      withdrawalDays: 23,
      benefitGrossMinor: 2_640_400,
      topupGrossMinor: 450_000,
      netMinor: 2_116_924,
      source: "estimate",
      parametersYear: 2027,
      parametersFallback: false,
    });
  });

  it("delmånad: föräldralönen räknas på andelen av månaden", () => {
    const months = estimateLeaveIncome({ ...leave, from: "2027-03-15", to: "2027-04-14", daysPerWeek: 7 }, [p2027]);
    expect(months.map((m) => [m.month, m.leaveDays, m.withdrawalDays, m.topupGrossMinor])).toEqual([
      ["2027-03", 17, 17, 246_774],
      ["2027-04", 14, 14, 210_000],
    ]);
  });

  it("en period över ett årsskifte använder varje års parametrar och varnar när ett år saknas", () => {
    const months = estimateLeaveIncome({ ...leave, from: "2026-12-01", to: "2027-01-31", daysPerWeek: 7, sgiAnnualMinor: 90_000_000 }, [p2026]);
    expect(months.map((m) => [m.month, m.parametersYear, m.parametersFallback, m.benefitGrossMinor])).toEqual([
      ["2026-12", 2026, false, 31 * 125_900],
      ["2027-01", 2026, true, 31 * 125_900],
    ]);
  });

  it("utan föräldralön och skatt är netto lika med föräldrapenningen", () => {
    const [march] = estimateLeaveIncome({ ...leave, to: "2027-03-31", employerTopupPct: 0, taxRatePct: 0 }, [p2027]);
    expect(march?.netMinor).toBe(2_640_400);
  });

  it("ett manuellt belopp vinner och delas efter andelen av månaden (KK-23-B)", () => {
    const months = estimateLeaveIncome({ ...leave, from: "2027-03-15", to: "2027-04-30", overrideNetMonthlyMinor: 2_000_000 }, [p2027]);
    expect(months.map((m) => [m.month, m.netMinor, m.source])).toEqual([
      ["2027-03", 1_096_774, "manual"],
      ["2027-04", 2_000_000, "manual"],
    ]);
  });

  it("ett manuellt belopp kräver inga årsparametrar", () => {
    const [march] = estimateLeaveIncome({ ...leave, to: "2027-03-31", overrideNetMonthlyMinor: 0 }, []);
    expect(march).toMatchObject({ netMinor: 0, source: "manual", parametersYear: null, parametersFallback: false });
  });

  it("vägrar ogiltiga perioder", () => {
    expect(() => estimateLeaveIncome({ ...leave, from: "2027-04-01", to: "2027-03-31" }, [p2027])).toThrow("Perioden slutar före den börjar");
    expect(() => estimateLeaveIncome({ ...leave, daysPerWeek: 7.5 }, [p2027])).toThrow("Dagar per vecka ska vara 0–7");
    expect(() => estimateLeaveIncome({ ...leave, daysPerWeek: -1 }, [p2027])).toThrow("Dagar per vecka ska vara 0–7");
    expect(() => estimateLeaveIncome({ ...leave, taxRatePct: 101 }, [p2027])).toThrow("Procent ska vara 0–100");
    expect(() => estimateLeaveIncome({ ...leave, employerTopupPct: -1 }, [p2027])).toThrow("Procent ska vara 0–100");
    expect(() => estimateLeaveIncome({ ...leave, overrideNetMonthlyMinor: 1.5 }, [p2027])).toThrow("Belopp måste vara ett heltal i öre");
  });

  it("en period på en enda dag, 0 dagar per vecka och 0 och 100 procent är giltiga", () => {
    expect(estimateLeaveIncome({ ...leave, to: "2027-03-31", daysPerWeek: 0, employerTopupPct: 0 }, [p2027])[0]?.netMinor).toBe(0);
    const months = estimateLeaveIncome({ ...leave, from: "2027-03-01", to: "2027-03-01", employerTopupPct: 100, taxRatePct: 100 }, [p2027]);
    expect(months).toHaveLength(1);
    expect(months[0]?.netMinor).toBe(0);
  });
});

describe("skillnad mot en normal månad (KK-23-A)", () => {
  it("hel månad: inkomsten är uppskattningen och skillnaden är mot normal nettolön", () => {
    const months = estimateLeaveIncome({ ...leave, to: "2027-03-31" }, [p2027]);
    expect(compareWithNormal(months, 3_300_000)).toEqual([{ month: "2027-03", incomeMinor: 2_116_924, differenceMinor: -1_183_076 }]);
  });

  it("delmånad: lön för dagarna utanför ledigheten räknas med", () => {
    const months = estimateLeaveIncome({ ...leave, from: "2027-04-16", to: "2027-04-30", overrideNetMonthlyMinor: 3_000_000 }, [p2027]);
    // April har 30 dagar: 15 dagars lön (1 650 000) och 15 dagars manuellt belopp (1 500 000).
    expect(compareWithNormal(months, 3_300_000)).toEqual([{ month: "2027-04", incomeMinor: 3_150_000, differenceMinor: -150_000 }]);
  });

  it("vägrar en normal lön som inte är hela ören", () => {
    expect(() => compareWithNormal([], 1.5)).toThrow("Belopp måste vara ett heltal i öre");
  });
});
