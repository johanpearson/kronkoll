/**
 * Synk av ett konto (KK-7-A, KK-7-B, flödet F-dataflode): hämta sida för sida, mappa till
 * ImportedTransaction, stäm av mot det som redan finns och spara. Allt eller inget per konto:
 * ett fel på sida två lämnar databasen orörd, och en avkortad hämtning sparas aldrig, eftersom
 * den annars skulle få reconcile att tro att preliminära transaktioner har försvunnit.
 *
 * Funktionen kastar aldrig. Fel blir en felkod utan bankens svarstext, så att resultatet går att
 * logga och spara (KK-13). Fel isoleras därmed per konto.
 */
import { ProviderError, type BankDataProvider, type ProviderErrorCode, type ProviderTransaction } from "./bank.ts";
import { addDays } from "./calendar.ts";
import { normalizeCounterparty } from "./normalize.ts";
import { reconcile, type ImportedTransaction, type ReconcileResult, type StoredTransaction } from "./reconcile.ts";
import { syncDateFrom, type AccountSyncResult } from "./sync.ts";

/**
 * Första hämtningen ber om så lång historik som banken tillåter (KK-5-C). Klarar banken inte det,
 * eller blir det fler sidor än gränsen, hämtas så här många dagar i stället. Banker tillåter normalt
 * minst 90 dagar utan extra samtycke.
 */
export const FIRST_SYNC_DAYS = 90;
/** Skydd mot en bank som aldrig slutar bläddra. Fler sidor än så räknas som misslyckad hämtning. */
export const DEFAULT_MAX_PAGES = 20;
const MAX_DESCRIPTION_LENGTH = 140;

/** Porten mot lagringen. adapter-d1:s transactionRepository uppfyller den. */
export interface TransactionStore {
  forReconcile(accountIds: readonly string[], dateFrom: string | null): Promise<StoredTransaction[]>;
  save(result: ReconcileResult): Promise<void>;
  latestBookedDate(accountId: string): Promise<string | null>;
}

export interface SyncAccountInput {
  readonly provider: BankDataProvider;
  readonly store: TransactionStore;
  /** `id` är vårt id, `providerUid` bankens. */
  readonly account: { readonly id: string; readonly providerUid: string };
  /** Dagens datum i svensk tid. */
  readonly today: string;
  readonly newId: () => string;
  readonly maxPages?: number;
}

function toImported(accountId: string, tx: ProviderTransaction): ImportedTransaction {
  return {
    accountId,
    providerTxId: tx.providerTxId,
    status: tx.status,
    transactionDate: tx.transactionDate,
    bookingDate: tx.bookingDate,
    amountMinor: tx.amountMinor,
    counterpartyNorm: normalizeCounterparty(tx.counterparty),
    counterparty: tx.counterparty,
    description: tx.description.slice(0, MAX_DESCRIPTION_LENGTH),
  };
}

async function fetchAll(input: SyncAccountInput, dateFrom: string | null): Promise<ProviderTransaction[]> {
  const maxPages = input.maxPages ?? DEFAULT_MAX_PAGES;
  const fetched: ProviderTransaction[] = [];
  let continuationKey: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const result = await input.provider.transactions(input.account.providerUid, { dateFrom, continuationKey });
    fetched.push(...result.transactions);
    if (result.continuationKey === null) return fetched;
    continuationKey = result.continuationKey;
  }
  throw new ProviderError("FAILED");
}

/** Första hämtningen: längsta historiken, annars FIRST_SYNC_DAYS. Bara FAILED (t.ex. för lång period) prövas igen. */
async function fetchFirst(input: SyncAccountInput): Promise<ProviderTransaction[]> {
  try {
    return await fetchAll(input, null);
  } catch (error) {
    if (!(error instanceof ProviderError) || error.code !== "FAILED") throw error;
    return fetchAll(input, addDays(input.today, -FIRST_SYNC_DAYS));
  }
}

export async function syncAccount(input: SyncAccountInput): Promise<AccountSyncResult> {
  try {
    const { store, account, today } = input;
    const dateFrom = syncDateFrom(await store.latestBookedDate(account.id));
    const fetched = dateFrom === null ? await fetchFirst(input) : await fetchAll(input, dateFrom);
    const incoming = fetched.map((tx) => toImported(account.id, tx));
    const existing = await store.forReconcile([account.id], dateFrom);
    const result = reconcile({ existing, incoming, accountIds: [account.id], today, newId: input.newId });
    await store.save(result);
    return { ok: true, newCount: result.inserted.length, updatedCount: result.updated.length };
  } catch (error) {
    const code: ProviderErrorCode = error instanceof ProviderError ? error.code : "FAILED";
    return { ok: false, error: code };
  }
}
