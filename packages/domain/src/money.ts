/**
 * Belopp som heltal öre (beslut D-money). Bankens belopp kommer som decimalsträngar, t.ex.
 * "-123.45", och tolkas utan flyttal så att summor och dedup alltid blir exakta.
 */

const DECIMAL_AMOUNT = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/;

/** Kastar om värdet inte är ett säkert heltal öre. */
export function assertMinor(amountMinor: number): number {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new RangeError("Belopp måste vara ett heltal i öre");
  }
  return amountMinor;
}

/** Tolkar ett belopp med punkt som decimaltecken och högst två decimaler till öre. */
export function parseAmount(text: string): number {
  const match = DECIMAL_AMOUNT.exec(text.trim());
  if (match === null) {
    throw new RangeError("Ogiltigt belopp");
  }
  const [, sign = "", kronor = "", ore = ""] = match;
  const magnitude = Number(kronor) * 100 + Number(ore.padEnd(2, "0"));
  const amount = sign === "-" && magnitude !== 0 ? -magnitude : magnitude;
  return assertMinor(amount);
}

/** Summerar belopp i öre och kastar hellre än att tappa precision. */
export function sumMinor(amounts: readonly number[]): number {
  let total = 0;
  for (const amount of amounts) {
    total = assertMinor(total + assertMinor(amount));
  }
  return total;
}
