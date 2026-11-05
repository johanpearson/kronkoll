/**
 * Insikter om utgifter (KK-24-B, KK-24-C). Utgifter räknas som i budgeten (domain/budget): bara
 * utgiftskategorier och okategoriserade utbetalningar, utan interna överföringar och borttagna,
 * uppdelade transaktioner per del. Återkommande dragningar (KK-24-A) finns i recurring.ts.
 */
import { spendingByCategory, type SpendingInput } from "./budget.ts";

export interface CategoryAnomaly {
  readonly categoryId: string;
  readonly actualMinor: number;
  /** Snittet av de tidigare perioderna, avrundat till hela ören. */
  readonly baselineMinor: number;
  readonly diffMinor: number;
  /** Ökning i procent av snittet, avrundad. Null när kategorin inte hade några utgifter tidigare. */
  readonly pct: number | null;
}

/** En avvikelse måste vara mer än så här många procent över snittet … */
export const ANOMALY_MIN_PCT = 30;
/** … och minst så här mycket i öre. */
export const ANOMALY_MIN_MINOR = 50_000;

/**
 * Kategorier vars utgifter i perioden ligger mer än 30 % och minst 500 kr över snittet för de tidigare
 * perioderna (normalt tre). En kategori som saknas en period räknas som noll den perioden. Bara
 * ökningar visas, största först. Okategoriserat räknas inte.
 */
export function spendingAnomalies(current: ReadonlyMap<string | null, number>, history: readonly ReadonlyMap<string | null, number>[]): CategoryAnomaly[] {
  if (history.length === 0) return [];
  const result: CategoryAnomaly[] = [];
  for (const [categoryId, actualMinor] of current) {
    if (categoryId === null) continue;
    const baselineMinor = Math.round(history.reduce((sum, h) => sum + (h.get(categoryId) ?? 0), 0) / history.length);
    const diffMinor = actualMinor - baselineMinor;
    if (diffMinor < ANOMALY_MIN_MINOR || diffMinor * 100 <= baselineMinor * ANOMALY_MIN_PCT) continue;
    result.push({ categoryId, actualMinor, baselineMinor, diffMinor, pct: baselineMinor === 0 ? null : Math.round((diffMinor * 100) / baselineMinor) });
  }
  return result.sort((a, b) => b.diffMinor - a.diffMinor);
}

export interface TopExpense {
  readonly id: string;
  readonly date: string;
  /** Utgiften som positivt belopp: för en uppdelad transaktion bara utgiftsdelarna. */
  readonly amountMinor: number;
  /** Kategorin, eller den största delens kategori för en uppdelad transaktion. */
  readonly categoryId: string | null;
  readonly split: boolean;
}

/** De största utgifterna i perioden, störst först och vid lika belopp nyast först. */
export function topExpenses(input: SpendingInput, limit = 5): TopExpense[] {
  const result: TopExpense[] = [];
  for (const tx of input.transactions) {
    const parts = [...spendingByCategory({ ...input, transactions: [tx] })].sort((a, b) => b[1] - a[1]);
    const amountMinor = parts.reduce((sum, [, amount]) => sum + amount, 0);
    if (amountMinor <= 0) continue;
    result.push({ id: tx.id, date: tx.date, amountMinor, categoryId: (parts[0] as [string | null, number])[0], split: (input.splits.get(tx.id)?.length ?? 0) > 0 });
  }
  return result.sort((a, b) => b.amountMinor - a.amountMinor || b.date.localeCompare(a.date)).slice(0, limit);
}

export interface MainCategorySpending {
  /** Huvudkategorin, eller null för okategoriserat. */
  readonly categoryId: string | null;
  readonly amountMinor: number;
}

/** Periodens utgifter per huvudkategori, störst först. Kategorier utan utgifter tas inte med. */
export function spendingByMainCategory(input: SpendingInput): MainCategorySpending[] {
  const parent = new Map(input.categories.map((c) => [c.id, c.parentId]));
  const totals = new Map<string | null, number>();
  for (const [categoryId, amount] of spendingByCategory(input)) {
    const main = parent.get(categoryId ?? "") ?? categoryId;
    totals.set(main, (totals.get(main) ?? 0) + amount);
  }
  return [...totals]
    .filter(([, amountMinor]) => amountMinor > 0)
    .map(([categoryId, amountMinor]) => ({ categoryId, amountMinor }))
    .sort((a, b) => b.amountMinor - a.amountMinor || (a.categoryId ?? "").localeCompare(b.categoryId ?? ""));
}
