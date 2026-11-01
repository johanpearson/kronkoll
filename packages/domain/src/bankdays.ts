/**
 * Svenska bankdagar (KK-34). Bankerna har stängt på helger, på alla allmänna helgdagar och
 * dessutom på midsommarafton, julafton och nyårsafton.
 */
import { addDays, dateOf, parseDate, weekday } from "./calendar.ts";

/** Påskdagen enligt den gregorianska kalendern (Meeus/Jones/Butcher). */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return dateOf(year, month, day);
}

/** Första dagen med given veckodag (0 = söndag) från och med ett datum. */
function firstWeekdayFrom(isoDate: string, day: number): string {
  return addDays(isoDate, (day - weekday(isoDate) + 7) % 7);
}

const cache = new Map<number, ReadonlySet<string>>();

/** Alla vardagar då svenska banker har stängt ett visst år (helgerna räknas separat). */
export function swedishBankHolidays(year: number): ReadonlySet<string> {
  const cached = cache.get(year);
  if (cached) return cached;
  const easter = easterSunday(year);
  const midsummerEve = firstWeekdayFrom(dateOf(year, 6, 19), 5);
  const holidays = new Set([
    dateOf(year, 1, 1), // nyårsdagen
    dateOf(year, 1, 6), // trettondedag jul
    addDays(easter, -2), // långfredagen
    addDays(easter, 1), // annandag påsk
    dateOf(year, 5, 1), // första maj
    addDays(easter, 39), // Kristi himmelsfärdsdag
    dateOf(year, 6, 6), // nationaldagen
    midsummerEve, // midsommarafton
    addDays(midsummerEve, 1), // midsommardagen
    firstWeekdayFrom(dateOf(year, 10, 31), 6), // alla helgons dag
    dateOf(year, 12, 24), // julafton
    dateOf(year, 12, 25), // juldagen
    dateOf(year, 12, 26), // annandag jul
    dateOf(year, 12, 31), // nyårsafton
  ]);
  cache.set(year, holidays);
  return holidays;
}

export function isBankDay(isoDate: string): boolean {
  const day = weekday(isoDate);
  if (day === 0 || day === 6) return false;
  return !swedishBankHolidays(parseDate(isoDate).getUTCFullYear()).has(isoDate);
}

/** Datumet självt om det är en bankdag, annars närmast föregående bankdag. */
export function previousBankDayOnOrBefore(isoDate: string): string {
  let date = isoDate;
  while (!isBankDay(date)) date = addDays(date, -1);
  return date;
}
