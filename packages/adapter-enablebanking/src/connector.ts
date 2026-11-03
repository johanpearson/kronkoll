/**
 * Enable Banking som BankConnector (KK-5, KK-8, flödet F-koppla).
 *
 * - Bara samtyckesanropen för kontoinformation (AIS): `GET /aspsps`, `POST /auth` och
 *   `POST /sessions`, och `DELETE /sessions/{id}` när en koppling raderas (KK-11-A). Inga betalningar (KK-5-A).
 * - Samtycket begärs med bankens längsta giltighetstid (`maximum_consent_validity`), eller 90
 *   dagar om banken inte anger någon, och alltid minus en timmes marginal.
 * - Ett fel innehåller bara en felkod, aldrig bankens svarstext, koden från banken eller state (KK-13).
 */
import { ProviderError, stockholmDate, type AuthorizationRequest, type BankConnector, type BankSession } from "@kronkoll/domain";
import type { JwtSigner } from "./jwt.ts";
import { errorFor, isObject, text } from "./provider.ts";

export interface EnableBankingConnectorOptions {
  readonly signer: JwtSigner;
  readonly fetch: typeof fetch;
  readonly baseUrl?: string;
  /** Klocka i millisekunder, injiceras för testbarhet. */
  readonly now?: () => number;
}

const DEFAULT_CONSENT_SECONDS = 90 * 86_400;
const MARGIN_SECONDS = 3600;

const bad = (): never => {
  throw new ProviderError("BAD_RESPONSE");
};

function httpsUrl(value: unknown): string {
  const raw = text(value);
  if (raw === null) return bad();
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.hostname !== "" ? raw : bad();
  } catch {
    return bad();
  }
}

export function createEnableBankingConnector(options: EnableBankingConnectorOptions): BankConnector {
  const base = options.baseUrl ?? "https://api.enablebanking.com";
  const now = options.now ?? (() => Date.now());

  async function call(method: "GET" | "POST", path: string, init: { query?: Record<string, string>; body?: unknown } = {}) {
    const url = new URL(path, base);
    for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value);
    const headers: Record<string, string> = { authorization: `Bearer ${await options.signer.sign()}` };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await options.fetch(url, { method, headers, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
    } catch {
      throw new ProviderError("UNAVAILABLE");
    }
    if (!res.ok) throw errorFor(res.status);
    const body: unknown = await res.json().catch(bad);
    return isObject(body) ? body : bad();
  }

  return {
    async startAuthorization(request: AuthorizationRequest) {
      const list = await call("GET", "/aspsps", { query: { country: request.country } });
      const aspsps = Array.isArray(list.aspsps) ? list.aspsps.filter(isObject) : bad();
      const aspsp = aspsps.find((a) => a.name === request.aspspName);
      if (!aspsp) throw new ProviderError("FAILED");

      const max = (typeof aspsp.maximum_consent_validity === "number" ? aspsp.maximum_consent_validity : DEFAULT_CONSENT_SECONDS) - MARGIN_SECONDS;
      const psuTypes = Array.isArray(aspsp.psu_types) ? aspsp.psu_types.filter((t): t is string => typeof t === "string") : [];
      const psuType = psuTypes.length === 0 || psuTypes.includes("personal") ? "personal" : (psuTypes[0] ?? "personal");

      const auth = await call("POST", "/auth", {
        body: {
          access: { valid_until: new Date(now() + Math.max(MARGIN_SECONDS, max) * 1000).toISOString() },
          aspsp: { name: request.aspspName, country: request.country },
          state: request.state,
          redirect_url: request.redirectUrl,
          psu_type: psuType,
        },
      });
      return { url: httpsUrl(auth.url) };
    },

    async createSession(code: string): Promise<BankSession> {
      const session = await call("POST", "/sessions", { body: { code } });
      const sessionId = text(session.session_id) ?? bad();
      const validUntil = isObject(session.access) ? text(session.access.valid_until) : null;
      if (validUntil === null) return { sessionId, consentExpiresOn: null };
      const instant = new Date(validUntil);
      return { sessionId, consentExpiresOn: Number.isNaN(instant.getTime()) ? bad() : stockholmDate(instant) };
    },

    async revokeSession(sessionId: string): Promise<void> {
      const url = new URL(`/sessions/${encodeURIComponent(sessionId)}`, base);
      let res: Response;
      try {
        res = await options.fetch(url, { method: "DELETE", headers: { authorization: `Bearer ${await options.signer.sign()}` } });
      } catch {
        throw new ProviderError("UNAVAILABLE");
      }
      // 404: sessionen finns inte längre hos banken, och det är just det vi vill.
      if (!res.ok && res.status !== 404) throw errorFor(res.status);
    },
  };
}
