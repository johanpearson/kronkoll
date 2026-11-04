/**
 * Prognos för sparmål (KK-21, #36).
 *
 * - Takten är snittsparandet de senaste 3 månaderna: summan av manuella avsättningar, eller av
 *   rörelserna på ett kopplat konto (saldots förändring), delat med 3. Uttag drar ned takten.
 * - Prognosen räknar hela månader framåt från i dag. En sista ofullständig månad räknas som en hel.
 * - Måldatum jämförs per månad: målet är i fas om det nås senast måldatumets månad. Belopp per
 *   månad som krävs är resten delat på månaderna fram till måldatumets månad, avrundat uppåt.
 * - Noll eller negativ takt ger "nås inte i nuvarande takt" i stället för ett datum (KK-21-B).
 *
 * Alla belopp är heltal öre (D-money).
 */
import { addMonths, parseDate, yearMonthOf, type YearMonth } from "./calendar.ts";
import { assertMinor, sumMinor } from "./money.ts";

/** Hur många månader bakåt takten räknas på. */
export const RATE_MONTHS = 3;

export interface GoalMovement {
  readonly date: string;
  /** Positivt för en avsättning eller insättning, negativt för ett uttag. */
  readonly amountMinor: number;
}

export interface GoalForecastInput {
  readonly targetMinor: number;
  /** Sparat hittills: startbelopp plus avsättningar, eller saldot på det kopplade kontot. */
  readonly savedMinor: number;
  readonly monthlyRateMinor: number;
  readonly targetDate: string | null;
  readonly today: string;
}

export type GoalForecast =
  | { readonly kind: "reached"; readonly remainingMinor: 0 }
  | { readonly kind: "never"; readonly remainingMinor: number; readonly requiredPerMonthMinor: number | null }
  | {
      readonly kind: "eta";
      readonly remainingMinor: number;
      /** Hela månader från i dag tills målet nås. */
      readonly months: number;
      /** Månaden då målet nås, ÅÅÅÅ-MM. */
      readonly reachedIn: string;
      readonly onTrack: boolean | null;
      /** Månader efter måldatumets månad, 0 om i fas. */
      readonly monthsLate: number | null;
      readonly requiredPerMonthMinor: number | null;
    };

// Bara skillnader används, så det spelar ingen roll var räkningen börjar.
const monthIndex = ({ year, month }: YearMonth) => year * 12 + month;
const formatMonth = ({ year, month }: YearMonth) => `${String(year)}-${String(month).padStart(2, "0")}`;

/** Samma dag för `months` månader sedan, eller månadens sista dag om den dagen saknas. */
function monthsBefore(isoDate: string, months: number): string {
  const { year, month } = addMonths(yearMonthOf(isoDate), -months);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = Math.min(parseDate(isoDate).getUTCDate(), lastDay);
  return `${formatMonth({ year, month })}-${String(day).padStart(2, "0")}`;
}

/** Snittsparande per månad de senaste 3 månaderna, avrundat nedåt till hela ören. */
export function averageMonthlySaving(movements: readonly GoalMovement[], today: string): number {
  for (const m of movements) assertMinor(m.amountMinor);
  const from = monthsBefore(today, RATE_MONTHS);
  const total = sumMinor(movements.filter((m) => m.date > from && m.date <= today).map((m) => m.amountMinor));
  return Math.floor(total / RATE_MONTHS);
}

/** När målet nås i nuvarande takt, om det är i fas och vad som krävs per månad. */
export function forecastGoal(input: GoalForecastInput): GoalForecast {
  const target = assertMinor(input.targetMinor);
  if (target <= 0) throw new RangeError("Målbeloppet måste vara större än 0");
  const saved = assertMinor(input.savedMinor);
  const rate = assertMinor(input.monthlyRateMinor);
  const now = yearMonthOf(input.today);
  const monthsLeft = input.targetDate === null ? null : monthIndex(yearMonthOf(input.targetDate)) - monthIndex(now);

  const remaining = target - saved;
  if (remaining <= 0) return { kind: "reached", remainingMinor: 0 };
  const required = monthsLeft === null ? null : monthsLeft <= 0 ? remaining : Math.ceil(remaining / monthsLeft);
  if (rate <= 0) return { kind: "never", remainingMinor: remaining, requiredPerMonthMinor: required };

  const months = Math.ceil(remaining / rate);
  const monthsLate = monthsLeft === null ? null : Math.max(0, months - Math.max(0, monthsLeft));
  return {
    kind: "eta",
    remainingMinor: remaining,
    months,
    reachedIn: formatMonth(addMonths(now, months)),
    onTrack: monthsLate === null ? null : monthsLate === 0,
    monthsLate,
    requiredPerMonthMinor: required,
  };
}
