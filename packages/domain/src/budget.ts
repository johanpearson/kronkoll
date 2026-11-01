/**
 * Budgetutfall per kategori (KK-20, beslut D-pending och D-rollover).
 *
 * - Bara utgifter räknas: kategorier av typen expense och okategoriserade utbetalningar. En
 *   okategoriserad insättning räknas som inkomst, inte som återbetalning (se overview.ts). Interna
 *   överföringar, kortfakturan (KK-20-C), överföringskategorier som Amortering och inkomster
 *   räknas inte.
 * - Preliminära räknas, borttagna inte. Uppdelade transaktioner räknas per del (KK-19-A).
 * - En budget på en huvudkategori täcker underkategorier som saknar egen budget, så att
 *   inget räknas två gånger (KK-20-A).
 * - Utfall och budget är positiva belopp i öre. En återbetalning minskar utfallet.
 * - Ingen rest förs över mellan perioder: varje period räknas för sig (D-rollover).
 */
import type { Category } from "./categories.ts";
import { assertMinor, sumMinor } from "./money.ts";
import type { BudgetPeriod } from "./period.ts";
import { allocateByCategory, type SplitPart } from "./split.ts";

export interface BudgetTransaction {
  readonly id: string;
  /** Svensk kalenderdag som avgör perioden: bokföringsdag, annars köpdag. */
  readonly date: string;
  readonly amountMinor: number;
  readonly categoryId: string | null;
  readonly status: "pending" | "booked" | "removed";
  /** Intern överföring eller kortfaktura enligt domain/transfers. */
  readonly internal: boolean;
}

export interface BudgetLineInput {
  readonly categoryId: string;
  /** Budgeterad utgift för perioden, positivt belopp i öre. */
  readonly amountMinor: number;
}

export interface BudgetLineOutcome {
  readonly categoryId: string;
  readonly budgetMinor: number;
  readonly actualMinor: number;
  readonly remainingMinor: number;
  /** Utfall i procent av budget, avrundat. Null om budgeten är noll. */
  readonly percent: number | null;
  readonly over: boolean;
}

export interface BudgetOutcome {
  readonly period: string;
  readonly lines: readonly BudgetLineOutcome[];
  /** Utgifter i kategorier utan budget, inklusive okategoriserade. */
  readonly unbudgetedMinor: number;
  readonly totalBudgetMinor: number;
  readonly totalActualMinor: number;
  /** Utbetalningar som var interna överföringar eller kortfaktura och därför inte räknas. */
  readonly excludedInternalMinor: number;
}

export interface SpendingInput {
  readonly period: BudgetPeriod;
  readonly transactions: readonly BudgetTransaction[];
  readonly splits: ReadonlyMap<string, readonly SplitPart[]>;
  readonly categories: readonly Category[];
}

const inPeriod = (date: string, period: BudgetPeriod) => date >= period.start && date <= period.end;

/** Utgifter per kategori (null = okategoriserat) för en period, som positiva belopp. */
export function spendingByCategory(input: SpendingInput): Map<string | null, number> {
  const kind = new Map(input.categories.map((c) => [c.id, c.kind]));
  const spending = new Map<string | null, number>();
  for (const tx of input.transactions) {
    assertMinor(tx.amountMinor);
    if (tx.status === "removed" || tx.internal || !inPeriod(tx.date, input.period)) continue;
    for (const part of allocateByCategory(tx, input.splits.get(tx.id) ?? [])) {
      if (part.categoryId === null && part.amountMinor > 0) continue;
      const partKind = part.categoryId === null ? "expense" : (kind.get(part.categoryId) ?? "expense");
      if (partKind !== "expense") continue;
      spending.set(part.categoryId, sumMinor([spending.get(part.categoryId) ?? 0, -part.amountMinor]));
    }
  }
  return spending;
}

function validateLines(lines: readonly BudgetLineInput[], categories: readonly Category[]): void {
  const seen = new Set<string>();
  for (const line of lines) {
    const category = categories.find((c) => c.id === line.categoryId);
    if (!category) throw new RangeError(`Okänd kategori i budgeten: ${line.categoryId}`);
    if (category.kind !== "expense") throw new RangeError("Budget kan bara sättas på utgiftskategorier");
    if (assertMinor(line.amountMinor) < 0) throw new RangeError("Budgeten kan inte vara negativ");
    if (seen.has(line.categoryId)) throw new RangeError(`Kategorin finns två gånger i budgeten: ${line.categoryId}`);
    seen.add(line.categoryId);
  }
}

export function budgetOutcome(input: SpendingInput & { readonly lines: readonly BudgetLineInput[] }): BudgetOutcome {
  validateLines(input.lines, input.categories);
  const spending = spendingByCategory(input);
  const budgeted = new Set(input.lines.map((l) => l.categoryId));

  const lines = input.lines.map((line): BudgetLineOutcome => {
    // En huvudkategori täcker sina underkategorier som inte har egen budget.
    const covered = [
      line.categoryId,
      ...input.categories.filter((c) => c.parentId === line.categoryId && !budgeted.has(c.id)).map((c) => c.id),
    ];
    const actualMinor = sumMinor(covered.map((id) => spending.get(id) ?? 0));
    return {
      categoryId: line.categoryId,
      budgetMinor: line.amountMinor,
      actualMinor,
      remainingMinor: line.amountMinor - actualMinor,
      percent: line.amountMinor === 0 ? null : Math.round((actualMinor * 100) / line.amountMinor),
      over: actualMinor > line.amountMinor,
    };
  });

  const totalActualMinor = sumMinor([...spending.values()]);
  const excludedInternalMinor = sumMinor(
    input.transactions
      .filter((t) => t.internal && t.status !== "removed" && t.amountMinor < 0 && inPeriod(t.date, input.period))
      .map((t) => -t.amountMinor),
  );
  return {
    period: input.period.key,
    lines,
    unbudgetedMinor: totalActualMinor - sumMinor(lines.map((l) => l.actualMinor)),
    totalBudgetMinor: sumMinor(lines.map((l) => l.budgetMinor)),
    totalActualMinor,
    excludedInternalMinor,
  };
}

/** Förslag: samma budget som föregående period. */
export function suggestFromPrevious(previous: readonly BudgetLineInput[]): BudgetLineInput[] {
  return previous.map((line) => ({ ...line }));
}

const ROUND_TO_MINOR = 1000;

/**
 * Förslag: snittet av utgifterna per kategori i de senaste perioderna (normalt tre), avrundat
 * uppåt till hela tiotal kronor. En kategori som saknas en period räknas som noll den perioden.
 */
export function suggestFromAverage(history: readonly ReadonlyMap<string | null, number>[]): BudgetLineInput[] {
  if (history.length === 0) return [];
  const categoryIds = [...new Set(history.flatMap((h) => [...h.keys()]))]
    .filter((id): id is string => id !== null)
    .sort();
  return categoryIds
    .map((categoryId) => {
      const total = sumMinor(history.map((h) => h.get(categoryId) ?? 0));
      const average = total / history.length;
      return { categoryId, amountMinor: Math.ceil(average / ROUND_TO_MINOR) * ROUND_TO_MINOR };
    })
    .filter((line) => line.amountMinor > 0);
}
