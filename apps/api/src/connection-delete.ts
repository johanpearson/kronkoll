// Radera en bankkoppling (#28, KK-11-A, KK-11-B, KK-32-A): DELETE /api/connections/{id}?purge=true|false.
//   1. Sessionen återkallas hos Enable Banking. Går det inte ändras ingenting, så att man kan försöka igen.
//   2. Utan purge: session-id raderas och kopplingen blir återkallad. Konton och historik finns kvar.
//   3. Med purge: kopplingen raderas, och med den konton, transaktioner, uppdelningar och saldon.
// Kvittensen säger ärligt att D1:s återställningspunkter (Time Travel) finns kvar i upp till 7 dagar.
// Regler, kategorier och budgetar behålls. Inget av det loggas med bankdata (KK-13).
import { connectionRepository, deriveKeys } from "@kronkoll/adapter-d1";
import { ProviderError } from "@kronkoll/domain";
import type { ConnectContext, ConnectEnv } from "./connections.ts";

/** Hur länge Cloudflare D1 sparar återställningspunkter på gratisnivån. */
export const BACKUP_EXPIRY_DAYS = 7;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

export async function deleteConnection(request: Request, env: ConnectEnv, context: ConnectContext, id: string): Promise<Response> {
  const purgeParam = new URL(request.url).searchParams.get("purge");
  if (purgeParam !== "true" && purgeParam !== "false") return json({ error: "invalid_request" }, 400);
  const purge = purgeParam === "true";

  const connector = context.connectorFor();
  const keys = connector && env.SESSION_ENC_KEY ? await deriveKeys(env.SESSION_ENC_KEY).catch(() => null) : null;
  if (!connector || !keys) return json({ error: "not_configured" }, 503);

  try {
    const connections = connectionRepository(env.DB, keys);
    if (!(await connections.get(id))) return json({ error: "not_found" }, 404);

    const sessionId = await connections.sessionId(id);
    if (sessionId !== null) {
      try {
        await connector.revokeSession(sessionId);
      } catch (error) {
        const code = error instanceof ProviderError ? error.code : "FAILED";
        return json({ error: "revoke_failed", code }, 502);
      }
    }

    if (!purge) {
      await connections.revoke(id);
      return json({ revoked: true, deleted: null, backup_expiry_days: BACKUP_EXPIRY_DAYS }, 200);
    }
    const deleted = await connections.historyCounts(id);
    await connections.delete(id);
    return json({ revoked: true, deleted, backup_expiry_days: BACKUP_EXPIRY_DAYS }, 200);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}
