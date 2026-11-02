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
  // Vanligt fält i stället för parameter property, så att Node kan köra filen utan transpilering.
  readonly code: ProviderErrorCode;

  constructor(code: ProviderErrorCode) {
    super(`Banken svarade med fel: ${code}`);
    this.code = code;
    this.name = "ProviderError";
  }
}

export interface AuthorizationRequest {
  readonly aspspName: string;
  readonly country: string;
  /** Det signerade engångs-state som banken skickar tillbaka (KK-29-A). */
  readonly state: string;
  readonly redirectUrl: string;
}

export interface BankSession {
  /** Bankens session-id. Krypteras innan det sparas (KK-11-C). */
  readonly sessionId: string;
  /** Sista dagen samtycket gäller, som svensk kalenderdag, eller null om banken inte säger det. */
  readonly consentExpiresOn: string | null;
}

/**
 * Porten för att koppla en bank (KK-5, KK-8, flödet F-koppla): starta samtycket och skapa
 * sessionen när användaren har godkänt med BankID. Bara kontoinformation begärs (KK-5-A).
 */
export interface BankConnector {
  /** Startar samtycket med bankens längsta giltighetstid och ger adressen användaren skickas till. */
  startAuthorization(request: AuthorizationRequest): Promise<{ url: string }>;
  /** Byter koden från banken mot en session. */
  createSession(code: string): Promise<BankSession>;
}

export interface BankDataProvider {
  /** Kontona i ett godkänt samtycke. */
  accounts(sessionId: string): Promise<BankAccount[]>;
  /** Bokfört saldo i öre, eller null om banken inte ger något. */
  balance(accountUid: string): Promise<number | null>;
  /** En sida transaktioner från och med ett datum. Hämtas sida för sida (CPU-gränsen, R-3). */
  transactions(accountUid: string, query: { dateFrom: string; continuationKey: string | null }): Promise<TransactionPage>;
}
