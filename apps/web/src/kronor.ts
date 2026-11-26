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
