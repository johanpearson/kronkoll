// Den schemalagda och manuella synken (KK-7). Kopplar ihop domänens syncConnection med D1 och
// Enable Banking. Logiken i sig ligger i domänen och är testad där. Här finns bara kopplingen,
// och den loggar bara id, antal, status och felkoder (KK-13-A), aldrig bankens text.
import {
  accountRepository,
  connectionRepository,
  deriveKeys,
  syncRunRepository,
  transactionRepository,
} from "@kronkoll/adapter-d1";
import { syncConnection, type BankDataProvider, type Clock, type SyncKind } from "@kronkoll/domain";
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

export async function runSync(env: SyncEnv, kind: SyncKind, deps: SyncDeps): Promise<void> {
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
      if (connection.provider !== "enablebanking") continue;
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
  } catch {
    logger.error("sync.failed", { error_code: "FAILED" });
  }
}
