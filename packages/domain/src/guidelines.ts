/**
 * Riktlinjer och sparläge (KK-42). Ren logik utan beroenden: normalnivå per kategori ur historiken,
 * utrymme att spendera fritt efter fasta kostnader och sparmål, fördelning på rörliga kategorier,
 * kvar per dag och om en kategori ligger över takt. Belopp är heltal öre (D-money).
 *
 * Läget (ingen budget, budget eller sparläge) och sparmålet lagras av adaptern. Här finns bara
 * räkningen.
 */
import { daysBetween } from "./calendar.ts";
import { assertMinor } from "./money.ts";
import type { BudgetPeriod } from "./period.ts";

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

export interface FreeSpendingInput {
  /** Förväntad inkomst för perioden. */
  readonly incomeMinor: number;
  /** Fasta kostnader: hyra, lån och återkommande dragningar. */
  readonly fixedMinor: number;
  /** Sparmål för perioden. */
  readonly savingGoalMinor: number;
}

export interface FreeSpending {
  /** Går sparmålet ihop med inkomsten och de fasta kostnaderna? */
  readonly feasible: boolean;
  /** Utrymme att spendera fritt, aldrig negativt. */
  readonly freeMinor: number;
  /** Hur mycket som saknas när det inte går ihop, annars noll. */
  readonly shortfallMinor: number;
}

function assertNonNegative(amountMinor: number): number {
  if (assertMinor(amountMinor) < 0) {
    throw new RangeError("Belopp får inte vara negativa");
  }
  return amountMinor;
}

/** Utrymme att spendera fritt = inkomst − fasta kostnader − sparmål (KK-42-B). Går det inte ihop saknas utrymme (KK-42-C). */
export function freeSpending(input: FreeSpendingInput): FreeSpending {
  const left = assertNonNegative(input.incomeMinor) - assertNonNegative(input.fixedMinor) - assertNonNegative(input.savingGoalMinor);
  return left >= 0 ? { feasible: true, freeMinor: left, shortfallMinor: 0 } : { feasible: false, freeMinor: 0, shortfallMinor: -left };
}

export interface VariableCategory {
  readonly categoryId: string;
  readonly normalMinor: number;
}

/**
 * Delar `amountMinor` på posterna i proportion till vikterna så att summan blir exakt (största rest
 * först, vid lika i given ordning eftersom `sort` är stabil). Är alla vikter noll delas det lika.
 */
function distribute<T>(amountMinor: number, items: readonly T[], weightOf: (item: T) => number): [T, number][] {
  const raw = items.map(weightOf);
  const equal = raw.every((w) => w === 0);
  const totalWeight = equal ? raw.length : raw.reduce((sum, w) => sum + w, 0);
  // BigInt: öre gånger öre kan passera det säkra heltalsområdet.
  const parts = items.map((item, index) => {
    const product = BigInt(amountMinor) * BigInt(equal ? 1 : weightOf(item));
    return { item, index, share: Number(product / BigInt(totalWeight)), rest: Number(product % BigInt(totalWeight)) };
  });
  const leftover = amountMinor - parts.reduce((sum, p) => sum + p.share, 0);
  const extra = new Set([...parts].sort((a, b) => b.rest - a.rest).slice(0, leftover).map((p) => p.index));
  return parts.map((p): [T, number] => [p.item, p.share + (extra.has(p.index) ? 1 : 0)]);
}

/**
 * Fördelar utrymmet att spendera fritt på de rörliga kategorierna i proportion till deras normalnivå
 * (KK-42-B). En manuell nivå (`overrides`, KK-42-A) behålls som den är och drar av från utrymmet, och
 * resten fördelas på de andra. Resultatet har samma ordning som `variable`. Summan av de
 * automatiska nivåerna är aldrig större än utrymmet.
 */
export function allocateFreeSpending(
  freeMinor: number,
  variable: readonly VariableCategory[],
  overrides: ReadonlyMap<string, number> = new Map(),
): Map<string, number> {
  const manual = variable.flatMap((c) => {
    const amount = overrides.get(c.categoryId);
    return amount === undefined ? [] : [{ categoryId: c.categoryId, amount: assertNonNegative(amount) }];
  });
  const automatic = variable.filter((c) => !overrides.has(c.categoryId));
  const remaining = Math.max(0, assertMinor(freeMinor) - manual.reduce((sum, m) => sum + m.amount, 0));
  const result = new Map(variable.map((c) => [c.categoryId, 0]));
  for (const [category, share] of distribute(remaining, automatic, (c) => assertNonNegative(c.normalMinor))) {
    result.set(category.categoryId, share);
  }
  for (const m of manual) result.set(m.categoryId, m.amount);
  return result;
}

function periodDays(period: BudgetPeriod): number {
  return daysBetween(period.start, period.end) + 1;
}

/** Hur många av periodens dagar som gått, inklusive i dag: 0 före starten och hela perioden efter slutet. */
function elapsedDays(today: string, period: BudgetPeriod): number {
  return Math.min(periodDays(period), Math.max(0, daysBetween(period.start, today) + 1));
}

/**
 * Kvar att spendera per dag resten av perioden (KK-42-C): det som är kvar delat på dagarna kvar
 * inklusive i dag, avrundat nedåt. Noll om inget är kvar eller perioden är slut. Före periodens
 * start räknas hela perioden.
 */
export function perDayMinor(remainingMinor: number, today: string, period: BudgetPeriod): number {
  const remaining = assertMinor(remainingMinor);
  const daysLeft = periodDays(period) - Math.max(0, daysBetween(period.start, today));
  return daysLeft <= 0 ? 0 : Math.max(0, Math.floor(remaining / daysLeft));
}

export interface PaceInput {
  /** Sparlägesnivån för kategorin, eller null om kategorin saknar nivå. */
  readonly levelMinor: number | null;
  /** Utfallet hittills i perioden. */
  readonly actualMinor: number;
  readonly today: string;
  readonly period: BudgetPeriod;
}

/**
 * Ligger kategorin över takt (KK-42-D)? Det gäller när utfallet är större än den andel av nivån som
 * motsvarar de dagar som gått. En kategori utan nivå markeras aldrig.
 */
export function isOverPace({ levelMinor, actualMinor, today, period }: PaceInput): boolean {
  if (levelMinor === null) return false;
  return assertMinor(actualMinor) * periodDays(period) > assertMinor(levelMinor) * elapsedDays(today, period);
}
