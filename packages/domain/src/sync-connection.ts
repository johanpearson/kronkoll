/**
 * Synk av en hel bankkoppling (KK-7, KK-8, flödet F-dataflode): kontrollera samtycket, synka
 * kontona ett i taget, spara saldon, logga körningen och registrera utfallet. Fel isoleras per
 * konto. Funktionen skickar ingen notis: den säger bara om en felnotis ska skickas och om
 * samtycket har gått ut, så att anroparen kan använda rätt kanal.
 *
 * Portarna uppfylls av adapter-d1 (körningslogg och kopplingsstatus) och av en liten
 * saldo-metod på kontorepositoryt. Bankdata når aldrig loggen, bara antal och felkoder (KK-13).
 */
import { ProviderError, type BankDataProvider } from "./bank.ts";
import { todayInStockholm, type Clock } from "./clock.ts";
import { consentStatus, type ConnectionStatus } from "./consent.ts";
import { syncAccount, type TransactionStore } from "./sync-account.ts";
import {
  classifyProviderFailure,
  shouldNotifySyncFailure,
  summarizeSyncRun,
  type AccountSyncResult,
  type SyncRunSummary,
} from "./sync.ts";

export type SyncKind = "cron" | "manual" | "initial" | "daily";

export interface SyncRunLog {
  start(run: { id: string; connectionId: string; kind: SyncKind; startedAt: string }): Promise<void>;
  finish(id: string, finishedAt: string, summary: SyncRunSummary): Promise<void>;
}

export interface ConnectionSyncState {
  /** Registrerar utfallet och returnerar antal misslyckade körningar i rad. */
  recordSyncOutcome(id: string, status: SyncRunSummary["status"], at: string): Promise<number>;
  /** Samtycket har gått ut: sätt kopplingen till expired. */
  expire(id: string): Promise<void>;
}

export interface BalanceStore {
  setBalance(accountId: string, balanceMinor: number): Promise<void>;
}

export interface SyncConnectionInput {
  readonly connection: { readonly id: string; readonly status: ConnectionStatus; readonly consentExpiresOn: string | null };
  readonly accounts: readonly { readonly id: string; readonly providerUid: string }[];
  readonly kind: SyncKind;
  readonly provider: BankDataProvider;
  readonly store: TransactionStore;
  readonly runs: SyncRunLog;
  readonly connections: ConnectionSyncState;
  readonly balances: BalanceStore;
  readonly clock: Clock;
  readonly newId: () => string;
}

export type SyncConnectionOutcome =
  | { readonly skipped: true; readonly reason: ConnectionStatus }
  | {
      readonly skipped: false;
      readonly runId: string;
      readonly summary: SyncRunSummary;
      /** Samtycket har gått ut. Banner och påminnelse sköts av samtyckesflödet, inte av felnotisen. */
      readonly consentExpired: boolean;
      /** Skicka "Synk misslyckas": tredje misslyckade körningen i rad (KK-7-B). */
      readonly notifyFailure: boolean;
    };

/** Ett konto: saldot hämtas först, och sparas först när transaktionerna också gått bra. */
async function syncOneAccount(input: SyncConnectionInput, account: { id: string; providerUid: string }): Promise<AccountSyncResult> {
  let balance: number | null;
  try {
    balance = await input.provider.balance(account.providerUid);
  } catch (error) {
    return { ok: false, error: error instanceof ProviderError ? error.code : "FAILED" };
  }
  const result = await syncAccount({
    provider: input.provider,
    store: input.store,
    account,
    today: todayInStockholm(input.clock),
    newId: input.newId,
  });
  if (result.ok && balance !== null) {
    try {
      await input.balances.setBalance(account.id, balance);
    } catch {
      return { ok: false, error: "FAILED" };
    }
  }
  return result;
}

export async function syncConnection(input: SyncConnectionInput): Promise<SyncConnectionOutcome> {
  const { connection } = input;
  const status = consentStatus({
    status: connection.status,
    consentExpiresOn: connection.consentExpiresOn,
    today: todayInStockholm(input.clock),
    bankRejected: false,
  });
  if (status !== "active" && status !== "expiring" && status !== "expired") return { skipped: true, reason: status };
  // En koppling som redan är utgången syns som expired i databasen och synkas inte om.
  if (status === "expired" && connection.status === "expired") return { skipped: true, reason: "expired" };

  const runId = input.newId();
  await input.runs.start({ id: runId, connectionId: connection.id, kind: input.kind, startedAt: input.clock.now().toISOString() });

  const results: AccountSyncResult[] = [];
  if (status === "expired") {
    // Datumet har passerat: fråga inte banken i onödan.
    results.push({ ok: false, error: "UNAUTHORIZED" });
  } else {
    for (const account of input.accounts) results.push(await syncOneAccount(input, account));
  }

  const summary = summarizeSyncRun(results);
  const consentExpired = results.some((r) => !r.ok && classifyProviderFailure(r.error).action === "expire_connection");
  const finishedAt = input.clock.now().toISOString();
  await input.runs.finish(runId, finishedAt, summary);
  const failuresInARow = await input.connections.recordSyncOutcome(connection.id, summary.status, finishedAt);
  if (consentExpired) await input.connections.expire(connection.id);

  return { skipped: false, runId, summary, consentExpired, notifyFailure: !consentExpired && shouldNotifySyncFailure(failuresInARow) };
}
