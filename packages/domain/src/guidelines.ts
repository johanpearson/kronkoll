/**
 * Normalnivå per kategori ur historiken (KK-42), som budgetplaneraren föreslår från. Ren logik utan
 * beroenden. Belopp är heltal öre (D-money). Engångsperioder lagras av adaptern, här finns bara räkningen.
 */
import { assertMinor } from "./money.ts";

/** Normalnivån räknas på så här många av de senaste perioderna. */
export const NORMAL_MONTHS = 6;

export interface PeriodSpending {
  /** Periodnyckel ÅÅÅÅ-MM, som i `BudgetPeriod.key`. */
  readonly key: string;
  /** Utgifter per kategori i perioden, räknade som i budgeten (`spendingByCategory`). */
  readonly spending: ReadonlyMap<string | null, number>;
}

export interface CategoryLevels {
  readonly categoryId: string;
  /** Snittet av de senaste perioderna, engångsperioder inräknade, avrundat till hela ören. */
  readonly averageMinor: number;
  /** Medianen av de senaste perioderna utan engångsperioder. */
  readonly normalMinor: number;
}

/** Medianen av belopp i öre. Med ett jämnt antal är det medelvärdet av de två mittersta, avrundat. */
export function medianMinor(amounts: readonly number[]): number {
  if (amounts.length === 0) return 0;
  const sorted = [...amounts].sort((x, y) => x - y);
  const middle = sorted.slice(Math.ceil(sorted.length / 2) - 1, Math.floor(sorted.length / 2) + 1);
  return Math.round(middle.reduce((sum, v) => sum + v, 0) / middle.length);
}

/**
 * Historiskt snitt och normalnivå per kategori (KK-42-A) över de senaste {@link NORMAL_MONTHS}
 * perioderna. En kategori som saknas en period räknas som noll den perioden. Perioder i
 * `oneOffKeys` (t.ex. en renoveringsmånad) ingår i snittet men lämnas utanför normalnivån.
 * Okategoriserat räknas inte. Resultatet är sorterat på kategori-id.
 */
export function categoryLevels(history: readonly PeriodSpending[], oneOffKeys: readonly string[]): CategoryLevels[] {
  const window = [...history].sort((a, b) => a.key.localeCompare(b.key)).slice(-NORMAL_MONTHS);
  const typical = window.filter((p) => !oneOffKeys.includes(p.key));
  const categoryIds = [...new Set(window.flatMap((p) => [...p.spending.keys()]))].filter((id): id is string => id !== null).sort();
  return categoryIds.map((categoryId) => {
    const total = window.reduce((sum, p) => sum + assertMinor(p.spending.get(categoryId) ?? 0), 0);
    return {
      categoryId,
      averageMinor: Math.round(total / window.length),
      normalMinor: medianMinor(typical.map((p) => p.spending.get(categoryId) ?? 0)),
    };
  });
}

/**
 * Summerar belopp per kategori uppåt till huvudkategorin, så att planen räknas på huvudkategorier
 * (KK-42). En kategori utan förälder, okategoriserat och en kategori som inte finns i trädet behålls som den är.
 */
export function rollUpToMain(amounts: ReadonlyMap<string | null, number>, parentOf: ReadonlyMap<string | null, string | null>): Map<string | null, number> {
  const result = new Map<string | null, number>();
  for (const [categoryId, amount] of amounts) {
    const main = parentOf.get(categoryId) ?? categoryId;
    result.set(main, assertMinor((result.get(main) ?? 0) + assertMinor(amount)));
  }
  return result;
}
