// Bankkopplingarna för Inställningar (#34, KK-7-A, KK-8-A): GET /api/connections. Status, hur länge
// samtycket gäller, senaste lyckade synk, misslyckade synkar i rad och antal konton. Avbrutna
// kopplingar (BankID som aldrig blev klart) visas inte. Session-id och kontonummer lämnar aldrig servern.
import { overviewRepository } from "@kronkoll/adapter-d1";
import { daysBetween, todayInStockholm } from "@kronkoll/domain";
import type { SyncDeps } from "./sync.ts";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

export async function listConnections(env: { DB: D1Database }, sync: SyncDeps): Promise<Response> {
  try {
    const today = todayInStockholm(sync.clock);
    const rows = (await overviewRepository(env.DB).connections()).filter((c) => c.status !== "pending_auth");
    return json(
      {
        items: rows.map((c) => ({
          id: c.id,
          bank: c.bank,
          status: c.status,
          consent_expires_on: c.consentExpiresOn,
          consent_days_left: c.consentExpiresOn === null ? null : daysBetween(today, c.consentExpiresOn),
          last_success_at: c.lastSuccessAt,
          consecutive_failures: c.consecutiveFailures,
          account_count: c.accountCount,
        })),
      },
      200,
    );
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}
