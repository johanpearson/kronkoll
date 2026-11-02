// Den schemalagda och manuella synken (KK-7). Kopplar ihop domänens syncConnection med D1 och
// Enable Banking. Logiken i sig ligger i domänen och är testad där. Här finns bara kopplingen,
// och den loggar bara id, antal, status och felkoder (KK-13-A), aldrig bankens text.
import {
  accountRepository,
  connectionRepository,
  deriveKeys,
  ruleRepository,
  syncRunRepository,
  transactionRepository,
} from "@kronkoll/adapter-d1";
import { applyRules, classifyTransfers, syncConnection, type BankDataProvider, type Clock, type OwnAccount, type SyncKind } from "@kronkoll/domain";
import type { Logger } from "@kronkoll/logging";

/** Det synken behöver ur Workerns miljö. Hemligheterna sätts i Cloudflare, aldrig i repot (KK-12). */
export interface SyncEnv {
  DB: D1Database;
  /** Secret: nyckel för session-id och IBAN-hash (base64, minst 32 byte). */
  SESSION_ENC_KEY?: string | undefined;
}

export interface SyncDeps {
  readonly logger: Logger;
  readonly clock: Clock;
  readonly newId: () => string;
  /** Banken att hämta från, eller null när dess hemligheter saknas. */
  readonly providerFor: () => BankDataProvider | null;
}

/** Synkar alla Enable Banking-kopplingar, eller bara en (`onlyConnectionId`, till exempel efter en ny koppling). */
export async function runSync(env: SyncEnv, kind: SyncKind, deps: SyncDeps, onlyConnectionId?: string): Promise<void> {
  const { logger } = deps;
  try {
    const provider = deps.providerFor();
    const keys = provider && env.SESSION_ENC_KEY ? await deriveKeys(env.SESSION_ENC_KEY).catch(() => null) : null;
    if (!provider || !keys) {
      logger.error("sync.not_configured");
      return;
    }

    const connections = connectionRepository(env.DB, keys);
    const accounts = accountRepository(env.DB, keys);
    const runs = syncRunRepository(env.DB);
    const store = transactionRepository(env.DB);

    for (const connection of await connections.list()) {
      if (connection.provider !== "enablebanking" || (onlyConnectionId !== undefined && connection.id !== onlyConnectionId)) continue;
      try {
        const outcome = await syncConnection({
          connection,
          accounts: await accounts.listForConnection(connection.id),
          kind,
          provider,
          store,
          runs,
          connections,
          balances: accounts,
          clock: deps.clock,
          newId: deps.newId,
        });
        if (outcome.skipped) {
          logger.info("sync.skipped", { connection_id: connection.id, status: outcome.reason });
          continue;
        }
        const { summary } = outcome;
        logger.info("sync.finished", {
          connection_id: connection.id,
          status: summary.status,
          new_count: summary.newCount,
          updated_count: summary.updatedCount,
          error_code: summary.errorCode,
        });
        if (outcome.consentExpired) logger.warn("sync.consent_expired", { connection_id: connection.id });
        // Web Push byggs i M3 (#42). Tills dess syns bara att en notis skulle ha skickats.
        if (outcome.notifyFailure) logger.warn("sync.failure_notice", { connection_id: connection.id });
      } catch {
        logger.error("sync.connection_failed", { connection_id: connection.id, error_code: "FAILED" });
      }
    }
    await categorizeNew(env.DB, logger);
    await markTransfers(env.DB, (await accounts.list()).map((a) => ({ id: a.id, type: a.type === "loan" ? "savings" : a.type })), logger);
  } catch {
    logger.error("sync.failed", { error_code: "FAILED" });
  }
}

/**
 * Kategoriserar transaktioner som saknar kategori med reglerna (KK-18, steget s-categorize i
 * F-dataflode). Manuella och redan kategoriserade rörs inte. Ett fel här stoppar inte synken:
 * transaktionerna är redan sparade och kategoriseras vid nästa körning.
 */
async function categorizeNew(db: D1Database, logger: Logger): Promise<void> {
  try {
    const store = transactionRepository(db);
    const changes = applyRules(await store.uncategorized(), await ruleRepository(db).list());
    await store.setCategories(changes);
    if (changes.length > 0) logger.info("sync.categorized", { count: changes.length });
  } catch {
    logger.error("sync.categorize_failed", { error_code: "FAILED" });
  }
}

/**
 * Markerar interna överföringar mellan egna konton (KK-20-C, steget s-transfer i F-dataflode), så att
 * budgeten inte räknar dem som utgift. Hela historiken räknas om, eftersom en ny transaktion kan ge en
 * gammal sin motpost. Bara det som ändras skrivs. Ingen lista med kortfaktura-mottagare än: korten hör
 * till vanliga konton. Ett fel här stoppar inte synken.
 */
async function markTransfers(db: D1Database, ownAccounts: OwnAccount[], logger: Logger): Promise<void> {
  try {
    const store = transactionRepository(db);
    const current = await store.forTransfers();
    const now = new Map(current.map((t) => [t.id, t]));
    const changes = classifyTransfers({ transactions: current, accounts: ownAccounts, cardPaymentCounterparties: [] })
      .filter((c) => now.get(c.id)?.internal !== c.internal || now.get(c.id)?.pairId !== c.pairId)
      .map((c) => ({ id: c.id, internal: c.internal, pairId: c.pairId }));
    await store.setTransfers(changes);
    if (changes.length > 0) logger.info("sync.transfers", { count: changes.length });
  } catch {
    logger.error("sync.transfers_failed", { error_code: "FAILED" });
  }
}
