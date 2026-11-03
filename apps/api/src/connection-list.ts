// Bankkopplingarna för Inställningar (#34, KK-7-A, KK-8-A): GET /api/connections. Status, hur länge
// samtycket gäller, senaste lyckade synk, misslyckade synkar i rad och antal konton. Avbrutna
// kopplingar (BankID som aldrig blev klart) visas inte. Session-id och kontonummer lämnar aldrig servern.
import { connectionHistoryCounts, overviewRepository, type OverviewConnection } from "@kronkoll/adapter-d1";
import { daysBetween, todayInStockholm } from "@kronkoll/domain";
import type { SyncDeps } from "./sync.ts";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

/** Så många synkkörningar som sidan om en koppling visar. */
export const SYNC_LOG_LENGTH = 20;

function toItem(c: OverviewConnection, today: string) {
  return {
    id: c.id,
    bank: c.bank,
    status: c.status,
    consent_expires_on: c.consentExpiresOn,
    consent_days_left: c.consentExpiresOn === null ? null : daysBetween(today, c.consentExpiresOn),
    last_success_at: c.lastSuccessAt,
    consecutive_failures: c.consecutiveFailures,
    account_count: c.accountCount,
  };
}

export async function listConnections(env: { DB: D1Database }, sync: SyncDeps): Promise<Response> {
  try {
    const today = todayInStockholm(sync.clock);
    const rows = (await overviewRepository(env.DB).connections()).filter((c) => c.status !== "pending_auth");
    return json({ items: rows.map((c) => toItem(c, today)) }, 200);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}

/**
 * GET /api/connections/{id}: samma uppgifter som i listan, plus kopplingens konton och de senaste
 * synkkörningarna (KK-7-A), och hur mycket historik som raderas med kopplingen (KK-11-B). Körningarna har bara status, antal och felkod, aldrig bankens text (KK-13).
 */
export async function getConnection(env: { DB: D1Database }, sync: SyncDeps, id: string): Promise<Response> {
  try {
    const repo = overviewRepository(env.DB);
    const connection = (await repo.connections()).find((c) => c.id === id && c.status !== "pending_auth");
    if (!connection) return json({ error: "not_found" }, 404);
    const [accounts, runs, history] = await Promise.all([repo.connectionAccounts(id), repo.syncRuns(id, SYNC_LOG_LENGTH), connectionHistoryCounts(env.DB, id)]);
    return json(
      {
        ...toItem(connection, todayInStockholm(sync.clock)),
        accounts: accounts.map((a) => ({ id: a.id, name: a.name, type: a.type, balance_minor: a.balanceMinor })),
        // Vad som raderas om kopplingen raderas med historik (KK-11-B).
        history,
        sync_runs: runs.map((r) => ({
          kind: r.kind,
          status: r.status,
          started_at: r.startedAt,
          finished_at: r.finishedAt,
          new_count: r.newCount,
          updated_count: r.updatedCount,
          error_code: r.errorCode,
        })),
      },
      200,
    );
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}
