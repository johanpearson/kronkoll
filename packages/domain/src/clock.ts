/**
 * Clock-porten och svensk tid (KK-33). Workers körs i UTC, men alla dags- och månadsgränser
 * räknas i Europe/Stockholm. Domänen läser aldrig systemklockan direkt, bara via Clock.
 */

export interface Clock {
  now(): Date;
}

/** En klocka som alltid visar samma ögonblick, för tester och omräkningar. */
export function fixedClock(instant: string): Clock {
  const date = new Date(instant);
  return { now: () => new Date(date) };
}

const stockholmFormatter = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Stockholm",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Den svenska kalenderdagen (ÅÅÅÅ-MM-DD) för ett ögonblick, med sommartid inräknad. */
export function stockholmDate(instant: Date): string {
  if (Number.isNaN(instant.getTime())) {
    throw new RangeError("Ogiltigt ögonblick");
  }
  const parts = Object.fromEntries(stockholmFormatter.formatToParts(instant).map((p) => [p.type, p.value]));
  return `${String(parts.year)}-${String(parts.month)}-${String(parts.day)}`;
}

export function todayInStockholm(clock: Clock): string {
  return stockholmDate(clock.now());
}
