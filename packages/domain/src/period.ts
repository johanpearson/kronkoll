/**
 * Budgetperioder (KK-33, KK-34). Standard är kalendermånaden. Med en startdag, t.ex. den 25:e
 * (lönedag), börjar perioden den dagen, eller närmast föregående bankdag om den inte är en
 * bankdag. Perioden slutar dagen före nästa periods (flyttade) start.
 *
 * Varje period har en nyckel ÅÅÅÅ-MM (används i /api/budgets/{period}). En startdag 1–15 hör
 * till samma månad, en startdag 16–28 till nästa månad: lön den 25 oktober är novemberbudget.
 */
import { previousBankDayOnOrBefore } from "./bankdays.ts";
import { addDays, addMonths, dateOf, parseDate, weekday, yearMonthOf, type YearMonth } from "./calendar.ts";
import { todayInStockholm, type Clock } from "./clock.ts";

export interface BudgetPeriod {
  /** ÅÅÅÅ-MM. */
  readonly key: string;
  /** Första dagen, inklusive. */
  readonly start: string;
  /** Sista dagen, inklusive. */
  readonly end: string;
}

const KEY = /^(\d{4})-(0[1-9]|1[0-2])$/;
const LAST_SAME_MONTH_START_DAY = 15;

function assertStartDay(startDay: number): void {
  if (!Number.isInteger(startDay) || startDay < 1 || startDay > 28) {
    throw new RangeError("Periodens startdag måste vara ett heltal 1–28");
  }
}

/** När perioden som startar i en viss månad faktiskt börjar. */
function startIn({ year, month }: YearMonth, startDay: number): string {
  const nominal = dateOf(year, month, startDay);
  return startDay === 1 ? nominal : previousBankDayOnOrBefore(nominal);
}

function keyOf(startMonth: YearMonth, startDay: number): string {
  const { year, month } = startDay > LAST_SAME_MONTH_START_DAY ? addMonths(startMonth, 1) : startMonth;
  return `${String(year)}-${String(month).padStart(2, "0")}`;
}

function periodStartingIn(startMonth: YearMonth, startDay: number): BudgetPeriod {
  return {
    key: keyOf(startMonth, startDay),
    start: startIn(startMonth, startDay),
    end: addDays(startIn(addMonths(startMonth, 1), startDay), -1),
  };
}

/** Den budgetperiod som ett bokföringsdatum (svensk kalenderdag) hör till. */
export function budgetPeriodOf(isoDate: string, startDay: number): BudgetPeriod {
  assertStartDay(startDay);
  parseDate(isoDate);
  const month = yearMonthOf(isoDate);
  // Nästa månads start kan ha flyttats bakåt in i den här månaden, så börja där.
  for (const offset of [1, 0, -1]) {
    const candidate = addMonths(month, offset);
    if (startIn(candidate, startDay) <= isoDate) return periodStartingIn(candidate, startDay);
  }
  /* c8 ignore next */
  throw new RangeError(`Ingen period hittades för ${isoDate}`);
}

/** Perioden med en viss nyckel, t.ex. "2026-11". */
export function budgetPeriodForKey(key: string, startDay: number): BudgetPeriod {
  assertStartDay(startDay);
  const match = KEY.exec(key);
  if (match === null) {
    throw new RangeError(`Ogiltig periodnyckel: ${key}`);
  }
  const keyMonth = { year: Number(match[1]), month: Number(match[2]) };
  return periodStartingIn(startDay > LAST_SAME_MONTH_START_DAY ? addMonths(keyMonth, -1) : keyMonth, startDay);
}

/** Perioden som pågår just nu, räknat på svensk tid. */
export function currentBudgetPeriod(clock: Clock, startDay: number): BudgetPeriod {
  return budgetPeriodOf(todayInStockholm(clock), startDay);
}

/** Måndagen i den vecka datumet ligger i (KK-4-B). */
export function weekStart(isoDate: string): string {
  return addDays(isoDate, -((weekday(isoDate) + 6) % 7));
}
