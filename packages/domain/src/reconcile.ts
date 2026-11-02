/**
 * Dedup och preliminär → bokförd (KK-9, KK-10-B, beslut D-dedup).
 *
 * 1. Bankens id först: samma konto och samma provider-id.
 * 2. Annars fingeravtryck: samma konto, belopp och normaliserade motpart, och datum inom ±3 dagar.
 *    När en preliminär blir bokförd får beloppet skilja högst 20 % (samma riktning); finns flera
 *    kandidater väljs den med minst beloppsskillnad. Varje befintlig rad kan bara matchas en gång, så två identiska köp samma dag blir två rader
 *    (löpnummer i praktiken). Två transaktioner med olika bank-id matchas aldrig, utom när en
 *    preliminär blir bokförd, eftersom banker ofta byter id just då.
 * 3. En matchad rad behåller sitt id, så kategori och uppdelning följer med. En bokförd blir
 *    aldrig preliminär igen.
 * 4. En preliminär som saknats i bankens svar i mer än 10 dagar markeras som borttagen.
 *
 * Funktionen är ren och deterministisk: samma indata i valfri ordning ger samma resultat.
 */
import { daysBetween, parseDate } from "./calendar.ts";
import { assertMinor } from "./money.ts";

export type TransactionStatus = "pending" | "booked" | "removed";

/** En transaktion som adaptern har mappat från bankens eller CSV-filens format. */
export interface ImportedTransaction {
  readonly accountId: string;
  readonly providerTxId: string | null;
  readonly status: "pending" | "booked";
  /** Köpdatum som svensk kalenderdag. Används för matchning. */
  readonly transactionDate: string;
  readonly bookingDate: string | null;
  readonly amountMinor: number;
  readonly counterpartyNorm: string;
}

export interface StoredTransaction extends Omit<ImportedTransaction, "status"> {
  readonly id: string;
  readonly status: TransactionStatus;
  /** Senaste dag (svensk tid) då banken levererade transaktionen. */
  readonly lastSeenOn: string;
}

export interface ReconcileInput {
  readonly existing: readonly StoredTransaction[];
  readonly incoming: readonly ImportedTransaction[];
  /** Konton som hämtades i den här synken. Bara de kan få borttagna preliminära. */
  readonly accountIds: readonly string[];
  /** Dagens datum i svensk tid. */
  readonly today: string;
  readonly newId: () => string;
}

export interface ReconcileResult {
  /** Nya rader. */
  readonly inserted: readonly StoredTransaction[];
  /** Befintliga rader med nytt innehåll (hela raden). Bara rader som faktiskt ändrats. */
  readonly updated: readonly StoredTransaction[];
}

export const MATCH_WINDOW_DAYS = 3;
export const PENDING_GRACE_DAYS = 10;
/** Största tillåtna beloppsskillnad i procent när en preliminär blir bokförd. */
export const AMOUNT_TOLERANCE_PERCENT = 20;

function validate(tx: ImportedTransaction): void {
  assertMinor(tx.amountMinor);
  parseDate(tx.transactionDate);
  if (tx.bookingDate !== null) parseDate(tx.bookingDate);
}

/** En total ordning så att resultatet inte beror på i vilken ordning banken skickar raderna. */
function canonicalKey(tx: ImportedTransaction): string {
  return [
    tx.accountId,
    tx.transactionDate,
    String(tx.amountMinor).padStart(20, "0"),
    tx.counterpartyNorm,
    tx.status === "booked" ? "0" : "1",
    tx.providerTxId ?? "",
    tx.bookingDate ?? "",
  ].join("\u0000");
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Får två transaktioner med olika bank-id ändå vara samma? Bara när en preliminär bokförs. */
function idsCompatible(existing: StoredTransaction, incoming: ImportedTransaction): boolean {
  if (existing.providerTxId === null || incoming.providerTxId === null) return true;
  if (existing.providerTxId === incoming.providerTxId) return true;
  return existing.status !== "booked" && incoming.status === "booked";
}

/**
 * Kan beloppen höra ihop? Normalt krävs exakt samma belopp. När en preliminär blir bokförd får
 * beloppet skilja högst 20 % (dricks, förhandsreservation, valutakurs), förutsatt samma riktning.
 * Procenten räknas av den preliminära summan, i heltalsaritmetik.
 */
function amountsCompatible(existing: StoredTransaction, incoming: ImportedTransaction): boolean {
  if (existing.amountMinor === incoming.amountMinor) return true;
  if (!(existing.status === "pending" && incoming.status === "booked")) return false;
  if (Math.sign(existing.amountMinor) !== Math.sign(incoming.amountMinor)) return false;
  return Math.abs(existing.amountMinor - incoming.amountMinor) * 100 <= Math.abs(existing.amountMinor) * AMOUNT_TOLERANCE_PERCENT;
}

/**
 * Fingeravtryck: samma konto och motpart, kompatibelt belopp och ±3 dagar. En preliminär från
 * banken matchas aldrig mot en redan bokförd här, eftersom det i praktiken är ett nytt köp. Bara
 * samma bank-id får knyta ihop dem.
 */
function sameFingerprint(existing: StoredTransaction, incoming: ImportedTransaction): boolean {
  return (
    !(existing.status === "booked" && incoming.status === "pending") &&
    existing.accountId === incoming.accountId &&
    amountsCompatible(existing, incoming) &&
    existing.counterpartyNorm === incoming.counterpartyNorm &&
    Math.abs(daysBetween(existing.transactionDate, incoming.transactionDate)) <= MATCH_WINDOW_DAYS &&
    idsCompatible(existing, incoming)
  );
}

/**
 * Bästa kandidaten: minst beloppsskillnad, sedan närmast i datum, samma status, samma id och samma
 * bokföringsdag, sedan stabil ordning. En rad som redan är identisk med den inkommande väljs alltså
 * alltid, så att en ny import av samma data inte flyttar om matchningarna.
 */
function bestCandidate(candidates: StoredTransaction[], incoming: ImportedTransaction): StoredTransaction | undefined {
  const score = (tx: StoredTransaction): number[] => [
    Math.abs(tx.amountMinor - incoming.amountMinor),
    Math.abs(daysBetween(tx.transactionDate, incoming.transactionDate)),
    tx.status === incoming.status ? 0 : 1,
    tx.providerTxId === incoming.providerTxId ? 0 : 1,
    tx.bookingDate === incoming.bookingDate ? 0 : 1,
  ];
  const byScore = (a: StoredTransaction, b: StoredTransaction): number => {
    const [sa, sb] = [score(a), score(b)];
    const differing = sa.findIndex((value, i) => value !== sb[i]);
    return differing === -1 ? 0 : (sa[differing] ?? 0) - (sb[differing] ?? 0);
  };
  return [...candidates].sort(
    (a, b) => byScore(a, b) || compareText(a.transactionDate, b.transactionDate) || compareText(a.id, b.id),
  )[0];
}

function merge(existing: StoredTransaction, incoming: ImportedTransaction, today: string): StoredTransaction {
  if (existing.status === "booked" && incoming.status === "pending") {
    return { ...existing, lastSeenOn: today };
  }
  return {
    id: existing.id,
    accountId: existing.accountId,
    providerTxId: incoming.providerTxId ?? existing.providerTxId,
    status: incoming.status,
    transactionDate: incoming.transactionDate,
    bookingDate: incoming.bookingDate,
    amountMinor: incoming.amountMinor,
    counterpartyNorm: incoming.counterpartyNorm,
    lastSeenOn: today,
  };
}

function changed(a: StoredTransaction, b: StoredTransaction): boolean {
  return (Object.keys(a) as (keyof StoredTransaction)[]).some((key) => a[key] !== b[key]);
}

export function reconcile(input: ReconcileInput): ReconcileResult {
  const { existing, today } = input;
  parseDate(today);
  input.incoming.forEach(validate);
  const incoming = [...input.incoming].sort((a, b) => compareText(canonicalKey(a), canonicalKey(b)));

  const unmatched = new Set(existing);
  const matches = new Map<StoredTransaction, ImportedTransaction>();
  const leftovers: ImportedTransaction[] = [];

  // 1. Bankens id.
  for (const tx of incoming) {
    const candidates = tx.providerTxId === null
      ? []
      : [...unmatched].filter((e) => e.accountId === tx.accountId && e.providerTxId === tx.providerTxId);
    const match = bestCandidate(candidates, tx);
    if (match) {
      unmatched.delete(match);
      matches.set(match, tx);
    } else {
      leftovers.push(tx);
    }
  }

  // 2. Fingeravtryck.
  const inserted: StoredTransaction[] = [];
  for (const tx of leftovers) {
    const match = bestCandidate([...unmatched].filter((e) => sameFingerprint(e, tx)), tx);
    if (match) {
      unmatched.delete(match);
      matches.set(match, tx);
    } else {
      inserted.push({ ...tx, id: input.newId(), lastSeenOn: today });
    }
  }

  const updated: StoredTransaction[] = [];
  for (const [before, tx] of matches) {
    const after = merge(before, tx, today);
    if (changed(before, after)) updated.push(after);
  }

  // 3. Försvunna preliminära i de konton som hämtades.
  const fetched = new Set(input.accountIds);
  for (const tx of unmatched) {
    if (tx.status === "pending" && fetched.has(tx.accountId) && daysBetween(tx.lastSeenOn, today) > PENDING_GRACE_DAYS) {
      updated.push({ ...tx, status: "removed" });
    }
  }

  return { inserted, updated };
}
