/**
 * Bokfört och disponibelt saldo per konto (KK-56-F), som översikten visar med och utan
 * preliminära (KK-60).
 *
 * Banken ger ett saldo med en saldotyp enligt ISO 20022. Bokförda typer (CLBD, ITBD, OPBD) har inte
 * de preliminära inräknade, medan förväntat och tillgängligt (XPCD, ITAV, CLAV) har det. Därför
 * räknas det andra saldot fram från de preliminära transaktionerna på kontot.
 */
import { assertMinor, sumMinor } from "./money.ts";

/** Saldot som banken lämnade, med bankens saldotyp, t.ex. "CLBD". Null för saldon sparade före #252. */
export interface BankBalance {
  readonly amountMinor: number;
  readonly type: string | null;
}

export interface AccountBalances {
  readonly bookedMinor: number;
  /** Bokfört minus preliminära utgifter plus preliminära insättningar. */
  readonly availableMinor: number;
  /** Summan av kontots preliminära, med tecken. */
  readonly pendingMinor: number;
}

const INCLUDES_PENDING: ReadonlySet<string | null> = new Set(["XPCD", "ITAV", "CLAV"]);

/** Sant om bankens saldo redan har de preliminära inräknade. Okända typer räknas som bokförda. */
export function includesPending(type: string | null): boolean {
  return INCLUDES_PENDING.has(type);
}

/** Kontots två saldon, från bankens saldo och beloppen på kontots preliminära transaktioner. */
export function accountBalances(balance: BankBalance, pendingAmounts: readonly number[]): AccountBalances {
  const amount = assertMinor(balance.amountMinor);
  const pendingMinor = sumMinor(pendingAmounts);
  const bookedMinor = includesPending(balance.type) ? amount - pendingMinor : amount;
  return { bookedMinor, availableMinor: bookedMinor + pendingMinor, pendingMinor };
}
