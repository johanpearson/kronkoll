import { describe, expect, it } from "vitest";
import { leaveImpact } from "./leave-impact.ts";
import type { MonthComparison } from "./income-forecast.ts";

const NORMAL = 3_300_000;

/** Ledighet mars–aug. 2027 där inkomsten är `ratio` av en normal månad. */
function leaveMonths(ratio: number): MonthComparison[] {
  const incomeMinor = Math.round(NORMAL * ratio);
  return ["2027-03", "2027-04", "2027-05", "2027-06", "2027-07", "2027-08"].map((month) => ({ month, incomeMinor, differenceMinor: incomeMinor - NORMAL }));
}

describe("kvar att spendera under ledigheten (KK-23-C)", () => {
  it("visar underskottet per månad när budgeten är större än inkomsten", () => {
    const { months } = leaveImpact({ months: leaveMonths(0.6), monthlyBudgetMinor: 3_200_000 });
    expect(months).toHaveLength(6);
    expect(months[0]).toEqual({ month: "2027-03", incomeMinor: 1_980_000, budgetMinor: 3_200_000, shortfallMinor: 1_220_000 });
  });

  it("inget underskott när inkomsten räcker, även när den är precis lika stor", () => {
    expect(leaveImpact({ months: leaveMonths(1), monthlyBudgetMinor: 3_200_000 }).months[0]?.shortfallMinor).toBe(0);
    expect(leaveImpact({ months: leaveMonths(0.6), monthlyBudgetMinor: 1_980_000 }).months[0]?.shortfallMinor).toBe(0);
  });

  it("vägrar en budget som inte är hela ören", () => {
    expect(() => leaveImpact({ months: [], monthlyBudgetMinor: 1.5 })).toThrow("Belopp måste vara ett heltal i öre");
  });
});
