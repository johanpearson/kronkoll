/**
 * Porten mot banken (KK-14-B, KK-5-A). Adaptrar för Enable Banking och CSV implementerar den.
 * Den kan bara läsa: det finns inga metoder för betalningar eller ändringar hos banken.
 *
 * Adaptern mappar bankens format hit och kastar resten. Belopp är heltal öre med tecken,
 * datum svenska kalenderdagar. Motpart och beskrivning är bankens text och är opålitlig indata
 * som alltid visas som text (KK-30).
 */
export type BankAccountType = "checking" | "credit_card" | "savings" | "loan";

export interface BankAccount {
  /** Bankens eller Enable Bankings id för kontot. */
  readonly providerUid: string;
  /** Används bara för att hasha och maska. Sparas aldrig i klartext. */
  readonly iban: string | null;
  readonly name: string;
  readonly type: BankAccountType;
  readonly currency: string;
}

export interface ProviderTransaction {
  readonly providerTxId: string | null;
  readonly status: "pending" | "booked";
  readonly transactionDate: string;
  readonly bookingDate: string | null;
  readonly amountMinor: number;
  readonly counterparty: string;
  /** Högst 140 tecken. */
  readonly description: string;
}

export interface TransactionPage {
  readonly transactions: readonly ProviderTransaction[];
  /** Nyckel till nästa sida, eller null när allt är hämtat. */
  readonly continuationKey: string | null;
}

/** Felkoder utan bankens svarstext, så att de kan loggas och sparas (KK-13). */
export type ProviderErrorCode = "UNAUTHORIZED" | "RATE_LIMITED" | "UNAVAILABLE" | "BAD_RESPONSE" | "FAILED";

export class ProviderError extends Error {
  constructor(readonly code: ProviderErrorCode) {
    super(`Banken svarade med fel: ${code}`);
    this.name = "ProviderError";
  }
}

export interface BankDataProvider {
  /** Kontona i ett godkänt samtycke. */
  accounts(sessionId: string): Promise<BankAccount[]>;
  /** Bokfört saldo i öre, eller null om banken inte ger något. */
  balance(accountUid: string): Promise<number | null>;
  /** En sida transaktioner från och med ett datum. Hämtas sida för sida (CPU-gränsen, R-3). */
  transactions(accountUid: string, query: { dateFrom: string; continuationKey: string | null }): Promise<TransactionPage>;
}
