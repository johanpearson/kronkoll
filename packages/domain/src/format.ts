/**
 * Svensk formatering av belopp och datum (KK-4).
 * Belopp hanteras alltid som heltal öre (beslut D-money); formatering sker bara här.
 */

const sekFormatter = new Intl.NumberFormat("sv-SE", {
  style: "currency",
  currency: "SEK",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const shortDateFormatter = new Intl.DateTimeFormat("sv-SE", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Formaterar ett belopp i öre, t.ex. 1234567 → "12 345,67 kr". */
export function formatSek(amountMinor: number): string {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new RangeError("Belopp måste vara ett heltal i öre");
  }
  return sekFormatter.format(amountMinor / 100);
}

/** Kort datum för listor, t.ex. "2026-11-03" → "3 nov. 2026". */
export function formatDateShort(isoDate: string): string {
  return shortDateFormatter.format(parseIsoDate(isoDate));
}

/** Datum för formulär, alltid ÅÅÅÅ-MM-DD. */
export function formatDateIso(isoDate: string): string {
  return parseIsoDate(isoDate).toISOString().slice(0, 10);
}

/** Tolkar ett kalenderdatum (utan tid) och avvisar datum som inte finns. */
function parseIsoDate(isoDate: string): Date {
  const match = ISO_DATE.exec(isoDate);
  if (match === null) {
    throw new RangeError(`Ogiltigt datum: ${isoDate}`);
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new RangeError(`Ogiltigt datum: ${isoDate}`);
  }
  return date;
}
