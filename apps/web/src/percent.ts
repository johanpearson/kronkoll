// Procentsats som användaren skriver i ett formulärfält, t.ex. räntan på ett lån.

/** Procent med decimalkomma, 0–100. Null om texten inte är en procentsats. */
export function parsePercent(text: string): number | null {
  const normalized = text.trim().replace(",", ".");
  if (!/^\d{1,3}(\.\d{1,2})?$/u.test(normalized)) return null;
  const value = Number(normalized);
  return value <= 100 ? value : null;
}
