import { describe, expect, it } from "vitest";
import { leaveImpact, type ImpactGoal } from "./leave-impact.ts";
import type { MonthComparison } from "./income-forecast.ts";

const NORMAL = 3_300_000;

/** Ledighet mars–aug. 2027 där inkomsten är `ratio` av en normal månad. */
function leaveMonths(ratio: number, months = ["2027-03", "2027-04", "2027-05", "2027-06", "2027-07", "2027-08"]): MonthComparison[] {
  const incomeMinor = Math.round(NORMAL * ratio);
  return months.map((month) => ({ month, incomeMinor, differenceMinor: incomeMinor - NORMAL }));
}

const resa: ImpactGoal = { id: "resa", targetMinor: 12_000_000, savedMinor: 0, monthlyRateMinor: 1_000_000, targetDate: "2028-01-31" };

function impact(goals: readonly ImpactGoal[], months = leaveMonths(0.6)) {
  return leaveImpact({ months, monthlyBudgetMinor: 3_200_000, goals, today: "2027-01-15" });
}

describe("kvar att spendera under ledigheten (KK-23-C)", () => {
  it("visar underskottet per månad när budgeten är större än inkomsten", () => {
    expect(impact([]).months[0]).toEqual({ month: "2027-03", incomeMinor: 1_980_000, budgetMinor: 3_200_000, shortfallMinor: 1_220_000 });
  });

  it("inget underskott när inkomsten räcker", () => {
    expect(impact([], leaveMonths(1)).months[0]?.shortfallMinor).toBe(0);
    expect(leaveImpact({ months: leaveMonths(0.6), monthlyBudgetMinor: 1_980_000, goals: [], today: "2027-01-15" }).months[0]?.shortfallMinor).toBe(0);
  });

  it("vägrar en budget som inte är hela ören", () => {
    expect(() => leaveImpact({ months: [], monthlyBudgetMinor: 1.5, goals: [], today: "2027-01-15" })).toThrow("Belopp måste vara ett heltal i öre");
  });
});

describe("sparmål räknas om med den lägre inkomsten (KK-23-C)", () => {
  it("sparandet minskar i samma takt som inkomsten: 60 % i sex månader ger 3 månader senare", () => {
    const [goal] = impact([resa]).goals;
    expect(goal?.id).toBe("resa");
    expect(goal?.before).toMatchObject({ kind: "eta", months: 12, reachedIn: "2028-01", onTrack: true });
    expect(goal?.after).toMatchObject({ kind: "eta", months: 15, reachedIn: "2028-04", onTrack: false, monthsLate: 3 });
    expect(goal?.lostSavingMinor).toBe(2_400_000);
    expect(goal?.monthsLater).toBe(3);
  });

  it("ett mål som nås före ledigheten påverkas inte", () => {
    const [goal] = impact([{ ...resa, targetMinor: 1_000_000 }]).goals;
    expect(goal).toMatchObject({ lostSavingMinor: 0, monthsLater: 0, after: { reachedIn: "2027-02" } });
  });

  it("räknar bara ledighetsmånader fram till att målet nås, även när förseningen drar in fler", () => {
    // Ingen inkomst alls i sex månader: målet på 3 månader nås först i oktober (feb, sep, okt).
    const [goal] = impact([{ ...resa, targetMinor: 3_000_000, targetDate: null }], leaveMonths(0)).goals;
    expect(goal).toMatchObject({ lostSavingMinor: 6_000_000, monthsLater: 6, after: { months: 9, reachedIn: "2027-10" } });
  });

  it("en ledighetsmånad i målets sista månad räknas, och förseningen drar in nästa", () => {
    // Utan ledighet nås målet i mars. Med 60 % i mars och april: 1 + 0,6 + 0,6 = 2,2 mn öre i april.
    const [goal] = impact([{ ...resa, targetMinor: 2_000_000 }]).goals;
    expect(goal).toMatchObject({ lostSavingMinor: 800_000, monthsLater: 1, after: { reachedIn: "2027-04" } });
  });

  it("innevarande månad och månader före i dag räknas inte, men nästa månad gör det", () => {
    const months = leaveMonths(0, ["2026-12", "2027-01"]);
    expect(impact([resa], months).goals[0]).toMatchObject({ lostSavingMinor: 0, monthsLater: 0 });
    expect(impact([resa], leaveMonths(0, ["2027-02"])).goals[0]).toMatchObject({ lostSavingMinor: 1_000_000, monthsLater: 1 });
  });

  it("högre inkomst än normalt ger inget extra sparande", () => {
    expect(impact([resa], leaveMonths(1.5)).goals[0]).toMatchObject({ lostSavingMinor: 0, monthsLater: 0 });
  });

  it("utan en normal månad att jämföra med räknas inget bortfall", () => {
    const months = [{ month: "2027-03", incomeMinor: 0, differenceMinor: 0 }];
    expect(impact([resa], months).goals[0]?.lostSavingMinor).toBe(0);
  });

  it("ett mål utan sparande nås inte före eller efter, och ett uppnått mål förblir uppnått", () => {
    const [never, reached] = impact([
      { ...resa, id: "aldrig", monthlyRateMinor: 0 },
      { ...resa, id: "klart", savedMinor: 12_000_000 },
    ]).goals;
    expect(never).toMatchObject({ before: { kind: "never" }, after: { kind: "never" }, lostSavingMinor: 0, monthsLater: null });
    expect(reached).toMatchObject({ before: { kind: "reached" }, after: { kind: "reached" }, lostSavingMinor: 0, monthsLater: null });
  });

  it("varje mål räknas för sig: ett mål med marginal förblir i fas", () => {
    const buffert: ImpactGoal = { id: "buffert", targetMinor: 2_000_000, savedMinor: 1_500_000, monthlyRateMinor: 300_000, targetDate: "2027-12-31" };
    const [, b] = impact([resa, buffert]).goals;
    expect(b).toMatchObject({ id: "buffert", lostSavingMinor: 240_000, monthsLater: 1, after: { reachedIn: "2027-04", onTrack: true } });
  });

  it("avrundar det kvarvarande sparandet nedåt till hela ören", () => {
    // 1/3 av 1 000 001 öre = 333 333,67 → 333 333 sparas, 666 668 försvinner.
    const months = [{ month: "2027-03", incomeMinor: 1_100_000, differenceMinor: -2_200_000 }];
    expect(impact([{ ...resa, monthlyRateMinor: 1_000_001 }], months).goals[0]?.lostSavingMinor).toBe(666_668);
  });
});
