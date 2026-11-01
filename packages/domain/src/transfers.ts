/**
 * Interna överföringar och kortfaktura (KK-20-C). Sådana transaktioner flyttar bara pengar mellan
 * hushållets egna konton och räknas därför inte som utgift eller inkomst i budgeten.
 *
 * 1. En manuell markering vinner alltid ("är en överföring" eller "inte en överföring").
 * 2. Par: motsatta belopp på två olika egna konton inom ±3 dagar. Varje transaktion ingår i högst
 *    ett par, och närmast i datum vinner. Eftersom Visa-kortet är ett eget konto fångar detta även
 *    betalningen av kortfakturan.
 * 3. Kortfaktura utan motpost: ett uttag från ett eget konto som inte är ett kortkonto, till en
 *    känd kortmottagare (t.ex. "skandia visa"). Listan är konfigurerbar (antagande A-6).
 *
 * En insättning på kortkontot utan motpost räknas inte som intern: det kan vara en återbetalning.
 */
import { daysBetween, parseDate } from "./calendar.ts";
import { assertMinor } from "./money.ts";

export const TRANSFER_WINDOW_DAYS = 3;

export interface OwnAccount {
  readonly id: string;
  readonly type: "checking" | "savings" | "credit_card" | "manual";
}

export interface TransferInput {
  readonly id: string;
  readonly accountId: string;
  readonly transactionDate: string;
  readonly amountMinor: number;
  readonly counterpartyNorm: string;
  readonly status: "pending" | "booked" | "removed";
  /** Användarens egen markering: true = överföring, false = inte överföring, null = automatiskt. */
  readonly manualTransfer: boolean | null;
}

export interface TransferClassification {
  readonly id: string;
  readonly internal: boolean;
  /** Den andra halvan av en överföring, om den finns. */
  readonly pairId: string | null;
  readonly reason: "manual" | "pair" | "card_payment" | "none";
}

export interface ClassifyTransfersInput {
  readonly transactions: readonly TransferInput[];
  readonly accounts: readonly OwnAccount[];
  /** Normaliserade motparter som betyder "betalning av kortfaktura". */
  readonly cardPaymentCounterparties: readonly string[];
}

const byDateThenId = (a: TransferInput, b: TransferInput): number =>
  a.transactionDate < b.transactionDate ? -1 : a.transactionDate > b.transactionDate ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

export function classifyTransfers(input: ClassifyTransfersInput): TransferClassification[] {
  for (const tx of input.transactions) {
    assertMinor(tx.amountMinor);
    parseDate(tx.transactionDate);
  }
  const accountType = new Map(input.accounts.map((a) => [a.id, a.type]));
  const cardPayees = new Set(input.cardPaymentCounterparties);
  const result = new Map<string, TransferClassification>();

  // 1. Manuella markeringar.
  for (const tx of input.transactions) {
    if (tx.manualTransfer !== null) {
      result.set(tx.id, { id: tx.id, internal: tx.manualTransfer, pairId: null, reason: "manual" });
    }
  }

  // 2. Par mellan olika egna konton.
  const eligible = input.transactions
    .filter((tx) => tx.manualTransfer === null && tx.status !== "removed" && accountType.has(tx.accountId))
    .sort(byDateThenId);
  const paired = new Set<string>();
  for (const out of eligible.filter((tx) => tx.amountMinor < 0)) {
    const match = eligible
      .filter(
        (tx) =>
          !paired.has(tx.id) &&
          tx.amountMinor === -out.amountMinor &&
          tx.accountId !== out.accountId &&
          Math.abs(daysBetween(out.transactionDate, tx.transactionDate)) <= TRANSFER_WINDOW_DAYS,
      )
      .sort(
        (a, b) =>
          Math.abs(daysBetween(out.transactionDate, a.transactionDate)) -
            Math.abs(daysBetween(out.transactionDate, b.transactionDate)) || byDateThenId(a, b),
      )[0];
    if (match) {
      paired.add(out.id).add(match.id);
      result.set(out.id, { id: out.id, internal: true, pairId: match.id, reason: "pair" });
      result.set(match.id, { id: match.id, internal: true, pairId: out.id, reason: "pair" });
    }
  }

  // 3. Kortfaktura utan motpost.
  for (const tx of eligible) {
    const type = accountType.get(tx.accountId);
    if (!paired.has(tx.id) && tx.amountMinor < 0 && type !== "credit_card" && cardPayees.has(tx.counterpartyNorm)) {
      result.set(tx.id, { id: tx.id, internal: true, pairId: null, reason: "card_payment" });
    }
  }

  return input.transactions.map(
    (tx) => result.get(tx.id) ?? { id: tx.id, internal: false, pairId: null, reason: "none" },
  );
}
