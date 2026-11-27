/**
 * Summering av en planerad budget (KK-42-C): inkomstrader, utgifter per huvudkategori och sparande. Ren
 * logik utan beroenden. Belopp är heltal öre (D-money) och aldrig negativa; det som blir över kan bli negativt,
 * och då är det ett underskott.
 */
import { assertMinor, sumMinor } from "./money.ts";

export interface PlanRowInput {
  readonly categoryId: string;
  /** Planerad utgift per månad. */
  readonly plannedMinor: number;
}

export interface BudgetPlanInput {
  /** Inkomster per månad, en per rad. */
  readonly incomesMinor: readonly number[];
  readonly rows: readonly PlanRowInput[];
  /** Planerat sparande per månad. */
  readonly savingMinor: number;
}

export interface PlanRow extends PlanRowInput {
  /** Radens andel av summan av inkomsterna i procent, avrundad, eller null utan inkomst. */
  readonly shareOfIncomePercent: number | null;
}

export interface BudgetPlan {
  readonly incomeMinor: number;
  readonly expensesMinor: number;
  readonly savingMinor: number;
  /** Utgifter plus sparande. */
  readonly totalMinor: number;
  /** Inkomst minus utgifter och sparande. Negativt är ett underskott. */
  readonly leftoverMinor: number;
  readonly deficit: boolean;
  readonly rows: readonly PlanRow[];
}

function nonNegative(amountMinor: number): number {
  if (assertMinor(amountMinor) < 0) {
    throw new RangeError("Belopp får inte vara negativa");
  }
  return amountMinor;
}

export function budgetPlan(input: BudgetPlanInput): BudgetPlan {
  const incomeMinor = sumMinor(input.incomesMinor.map(nonNegative));
  const expensesMinor = sumMinor(input.rows.map((r) => nonNegative(r.plannedMinor)));
  const savingMinor = nonNegative(input.savingMinor);
  const totalMinor = sumMinor([expensesMinor, savingMinor]);
  const leftoverMinor = incomeMinor - totalMinor;
  return {
    incomeMinor,
    expensesMinor,
    savingMinor,
    totalMinor,
    leftoverMinor,
    deficit: leftoverMinor < 0,
    rows: input.rows.map((r) => ({ ...r, shareOfIncomePercent: incomeMinor === 0 ? null : Math.round((r.plannedMinor * 100) / incomeMinor) })),
  };
}

export interface PlanProgress {
  /** Planerat minus utfall. Negativt när utfallet är större än planen. */
  readonly remainingMinor: number;
  /** Utfallet i procent av planen, avrundat, eller null när planen är noll. */
  readonly percent: number | null;
  /** Utfallet är större än planen. Med en plan på noll räknas allt som spenderats som över. */
  readonly over: boolean;
}

/** Utfall mot plan för en kategori (KK-45-A). */
export function planProgress(plannedMinor: number, actualMinor: number): PlanProgress {
  const planned = nonNegative(plannedMinor);
  const actual = assertMinor(actualMinor);
  return {
    remainingMinor: planned - actual,
    percent: planned === 0 ? null : Math.round((actual * 100) / planned),
    over: actual > planned,
  };
}
