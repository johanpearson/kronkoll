/**
 * Vad en planerad föräldraledighet gör med budgeten (KK-23-C, flöde F-leave): varje berörd månad jämförs
 * budgeten med inkomsten, och underskottet visas. Alla belopp är heltal öre (D-money).
 */
import type { MonthComparison } from "./income-forecast.ts";
import { assertMinor } from "./money.ts";

export interface LeaveImpactInput {
  /** Från `compareWithNormal`. */
  readonly months: readonly MonthComparison[];
  readonly monthlyBudgetMinor: number;
}

export interface MonthImpact {
  readonly month: string;
  readonly incomeMinor: number;
  readonly budgetMinor: number;
  /** Budget minus inkomst, 0 när inkomsten räcker. */
  readonly shortfallMinor: number;
}

export interface LeaveImpact {
  readonly months: readonly MonthImpact[];
}

/** Underskott per berörd månad (KK-23-C). */
export function leaveImpact(input: LeaveImpactInput): LeaveImpact {
  const budgetMinor = assertMinor(input.monthlyBudgetMinor);
  return {
    months: input.months.map((m) => ({
      month: m.month,
      incomeMinor: m.incomeMinor,
      budgetMinor,
      shortfallMinor: Math.max(0, budgetMinor - m.incomeMinor),
    })),
  };
}
