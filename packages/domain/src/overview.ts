/**
 * Översikten (KK-17): saldo, periodens in och ut, kvar att spendera och trend.
 *
 * "Månad" i kravet betyder budgetperiod, som kan börja på lönedagen (KK-4).
 * - Inkomst är inkomstkategorier plus okategoriserade insättningar. Utgift räknas som i
 *   budgeten (budget.ts). Interna överföringar och överföringskategorier som Amortering räknas
 *   varken som in eller ut.
 * - Kvar att spendera = budgeterade utgifter − alla utgifter hittills, även de utan budget,
 *   bokförda och preliminära (KK-17-B, D-pending). Kvar per dag räknar med dagens datum.
 */
import { addMonths, daysBetween } from "./calendar.ts";
import { spendingByCategory, type SpendingInput } from "./budget.ts";
import { assertMinor, sumMinor } from "./money.ts";
import { budgetPeriodForKey, type BudgetPeriod } from "./period.ts";
import { allocateByCategory } from "./split.ts";

export interface OverviewAccount {
  /** Saldo från senaste synk, eller null när banken inte har lämnat något (KK-38-B). */
  readonly balanceMinor: number | null;
  /** Användaren har valt kontot i översikten. */
  readonly included: boolean;
}

/** Totalt saldo över valda konton som har saldo (KK-17-A, KK-38-B). */
export function totalBalance(accounts: readonly OverviewAccount[]): number {
  return sumMinor(accounts.flatMap((a) => (a.included && a.balanceMinor !== null ? [assertMinor(a.balanceMinor)] : [])));
}

export interface PeriodTotals {
  readonly period: string;
  readonly incomeMinor: number;
  readonly expenseMinor: number;
  readonly netMinor: number;
}

/** Periodens inkomster, utgifter och netto (KK-17-A). */
export function periodTotals(input: SpendingInput): PeriodTotals {
  const kind = new Map(input.categories.map((c) => [c.id, c.kind]));
  const income: number[] = [];
  for (const tx of input.transactions) {
    if (tx.status === "removed" || tx.internal || tx.date < input.period.start || tx.date > input.period.end) continue;
    for (const part of allocateByCategory(tx, input.splits.get(tx.id) ?? [])) {
      const isIncome = part.categoryId === null ? part.amountMinor > 0 : kind.get(part.categoryId) === "income";
      if (isIncome) income.push(part.amountMinor);
    }
  }
  const incomeMinor = sumMinor(income);
  const expenseMinor = sumMinor([...spendingByCategory(input).values()]);
  return { period: input.period.key, incomeMinor, expenseMinor, netMinor: incomeMinor - expenseMinor };
}

export interface LeftToSpendInput {
  readonly period: BudgetPeriod;
  /** Svensk kalenderdag i dag. */
  readonly today: string;
  /** Summan av periodens budgeterade utgifter. */
  readonly budgetMinor: number;
  /** Periodens alla utgifter hittills. */
  readonly actualMinor: number;
}

export interface LeftToSpend {
  readonly leftMinor: number;
  /** Dagar kvar av perioden, i dag inräknad. Noll när perioden är slut. */
  readonly daysLeft: number;
  /** Kvar per dag, avrundat nedåt till helt öre. Noll när inget är kvar, null när perioden är slut. */
  readonly perDayMinor: number | null;
  readonly over: boolean;
}

/** "Kvar att spendera" och kvar per dag till periodens slut (KK-17-B). */
export function leftToSpend(input: LeftToSpendInput): LeftToSpend {
  const leftMinor = assertMinor(input.budgetMinor) - assertMinor(input.actualMinor);
  const from = input.today < input.period.start ? input.period.start : input.today;
  const daysLeft = Math.max(0, daysBetween(from, input.period.end) + 1);
  let perDayMinor: number | null = null;
  if (daysLeft > 0) perDayMinor = leftMinor > 0 ? Math.floor(leftMinor / daysLeft) : 0;
  return { leftMinor, daysLeft, perDayMinor, over: leftMinor < 0 };
}

/** De senaste `count` perioderna, äldst först, till och med `current` (KK-17-C). */
export function recentPeriods(current: BudgetPeriod, startDay: number, count: number): BudgetPeriod[] {
  if (!Number.isInteger(count) || count < 1) throw new RangeError("Antalet perioder måste vara minst 1");
  const [year, month] = current.key.split("-").map(Number) as [number, number];
  return Array.from({ length: count }, (_, i) => {
    const ym = addMonths({ year, month }, i - count + 1);
    return budgetPeriodForKey(`${String(ym.year)}-${String(ym.month).padStart(2, "0")}`, startDay);
  });
}

/** In, ut och netto per period för trenddiagrammet, äldst först (KK-17-C). */
export function trend(input: Omit<SpendingInput, "period"> & { readonly periods: readonly BudgetPeriod[] }): PeriodTotals[] {
  return input.periods.map((period) => periodTotals({ ...input, period }));
}
