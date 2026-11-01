/**
 * Räkning med kalenderdagar (ÅÅÅÅ-MM-DD) utan klockslag. Internt används UTC-datum, eftersom
 * ett datum utan tid inte har någon tidszon och då aldrig påverkas av sommartid.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

export interface YearMonth {
  readonly year: number;
  readonly month: number;
}

export function parseDate(isoDate: string): Date {
  const match = ISO_DATE.exec(isoDate);
  if (match === null) {
    throw new RangeError(`Ogiltigt datum: ${isoDate}`);
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new RangeError(`Ogiltigt datum: ${isoDate}`);
  }
  return date;
}

export function toIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function dateOf(year: number, month: number, day: number): string {
  return toIso(new Date(Date.UTC(year, month - 1, day)));
}

export function addDays(isoDate: string, days: number): string {
  return toIso(new Date(parseDate(isoDate).getTime() + days * DAY_MS));
}

/** 0 = söndag … 6 = lördag. */
export function weekday(isoDate: string): number {
  return parseDate(isoDate).getUTCDay();
}

export function addMonths({ year, month }: YearMonth, months: number): YearMonth {
  const index = year * 12 + (month - 1) + months;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

export function yearMonthOf(isoDate: string): YearMonth {
  const date = parseDate(isoDate);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}
