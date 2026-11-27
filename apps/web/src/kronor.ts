// Belopp i kronor som användaren skriver i ett formulärfält.
import { parseAmount } from "@kronkoll/domain";

/** Kronor som text till öre: null om texten inte är ett belopp. Tomt räknas som 0. */
export function parseKronor(text: string): number | null {
  // \s tar även hårda mellanslag, som Intl använder mellan tusental.
  const normalized = text.replace(/\s/gu, "").replace(",", ".");
  if (normalized === "") return 0;
  try {
    const ore = parseAmount(normalized);
    return ore < 0 ? null : ore;
  } catch {
    return null;
  }
}

/** Öre som text för ett fält: hela kronor utan decimaler, annars med ören, t.ex. "6300" eller "6300,50". */
export const toText = (ore: number) => (ore % 100 === 0 ? String(ore / 100) : (ore / 100).toFixed(2).replace(".", ","));

/** Fältets belopp i öre: null för tomt eller noll (ingen budget), undefined om texten inte är ett belopp. */
export function parseField(text: string): number | null | undefined {
  const parsed = parseKronor(text);
  if (parsed === null) return undefined;
  return parsed === 0 ? null : parsed;
}
