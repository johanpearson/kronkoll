/**
 * Dela upp en transaktion i flera kategorier (KK-19). Invarianten är att delarna summerar
 * exakt till originalbeloppet. Är det fel får användaren veta hur mycket som återstår (KK-19-B).
 */
import { assertMinor, sumMinor } from "./money.ts";

export interface SplitPart {
  readonly categoryId: string;
  readonly amountMinor: number;
}

export type SplitResult =
  | { readonly ok: true; readonly parts: readonly SplitPart[] }
  | {
      readonly ok: false;
      readonly error: "split_sum_mismatch";
      readonly expectedMinor: number;
      readonly actualMinor: number;
      /** Det som återstår att fördela: originalbeloppet minus delarnas summa. */
      readonly remainingMinor: number;
    }
  | { readonly ok: false; readonly error: "too_few_parts" | "invalid_part" };

export function validateSplit(amountMinor: number, parts: readonly SplitPart[]): SplitResult {
  assertMinor(amountMinor);
  parts.forEach((p) => assertMinor(p.amountMinor));
  if (parts.length < 2) return { ok: false, error: "too_few_parts" };

  const sign = Math.sign(amountMinor);
  const valid = sign !== 0 && parts.every((p) => p.categoryId !== "" && Math.sign(p.amountMinor) === sign);
  if (!valid) return { ok: false, error: "invalid_part" };

  const actualMinor = sumMinor(parts.map((p) => p.amountMinor));
  if (actualMinor !== amountMinor) {
    return { ok: false, error: "split_sum_mismatch", expectedMinor: amountMinor, actualMinor, remainingMinor: amountMinor - actualMinor };
  }
  return { ok: true, parts };
}

export interface Allocation {
  readonly categoryId: string | null;
  readonly amountMinor: number;
}

/**
 * Vilka belopp en transaktion bidrar med per kategori i budgeten: delarna om den är uppdelad,
 * annars hela beloppet i dess egen kategori. En uppdelning som inte håller används aldrig.
 */
export function allocateByCategory(
  transaction: { readonly amountMinor: number; readonly categoryId: string | null },
  parts: readonly SplitPart[],
): Allocation[] {
  if (parts.length > 0 && validateSplit(transaction.amountMinor, parts).ok) {
    return parts.map((p) => ({ categoryId: p.categoryId, amountMinor: p.amountMinor }));
  }
  return [{ categoryId: transaction.categoryId, amountMinor: transaction.amountMinor }];
}
