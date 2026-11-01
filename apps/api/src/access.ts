// Åtkomstkontroll för varje anrop till API-workern (KK-2-B, KK-29-B, hot T-S1 och T-T1).
// Workern litar aldrig på att den bara nås via Access. Saknas en inställning nekas allt.
import { checkCsrf, createAccessVerifier, type AccessJwk, type AccessResult } from "@kronkoll/adapter-access";
import type { Logger } from "@kronkoll/logging";

/** Inställningar för åtkomstkontrollen. Värdena läses från Worker-variabler och -secrets. */
export interface AccessEnv {
  /** Variabel, t.ex. "https://<team>.cloudflareaccess.com". */
  ACCESS_TEAM_DOMAIN?: string | undefined;
  /** Variabel: appens adress, används för CSRF-kontrollen. */
  APP_ORIGIN?: string | undefined;
  /** Secret: AUD-taggen för Access-applikationen som skyddar produktionsadressen. */
  ACCESS_AUD?: string | undefined;
  /** Secret: inbjudna e-postadresser, separerade med kommatecken. */
  ACCESS_ALLOWED_EMAILS?: string | undefined;
}

export interface AccessConfig {
  readonly issuer: string;
  readonly audience: string;
  readonly allowedEmails: readonly string[];
  readonly appOrigin: string;
}

export type Verify = (token: string | null) => Promise<AccessResult>;

const HTTPS_ORIGIN = /^https:\/\/[a-z0-9.-]+$/;

/** Returnerar null om någon inställning saknas eller ser fel ut. Då nekas alla anrop. */
export function readAccessConfig(env: AccessEnv): AccessConfig | null {
  const issuer = env.ACCESS_TEAM_DOMAIN?.trim() ?? "";
  const appOrigin = env.APP_ORIGIN?.trim() ?? "";
  const audience = env.ACCESS_AUD?.trim() ?? "";
  const allowedEmails = (env.ACCESS_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.includes("@"));

  if (!HTTPS_ORIGIN.test(issuer) || !HTTPS_ORIGIN.test(appOrigin)) return null;
  if (audience === "" || allowedEmails.length === 0) return null;
  return { issuer, audience, allowedEmails, appOrigin };
}

type FetchLike = (url: string) => Promise<Response>;

let cached: { key: string; verify: Verify } | undefined;

/** En verifierare per isolate, så att Access-nycklarna (JWKS) cachas mellan anrop. */
export function cachedVerifier(config: AccessConfig, fetchImpl: FetchLike = (url) => fetch(url)): Verify {
  const key = JSON.stringify(config);
  if (cached?.key !== key) {
    const verify = createAccessVerifier({
      issuer: config.issuer,
      audience: config.audience,
      allowedEmails: config.allowedEmails,
      fetchKeys: async () => {
        const res = await fetchImpl(`${config.issuer}/cdn-cgi/access/certs`);
        if (!res.ok) throw new Error(`jwks_${String(res.status)}`);
        const body: { keys?: AccessJwk[] } = await res.json();
        return body.keys ?? [];
      },
      now: () => Date.now(),
    });
    cached = { key, verify };
  }
  return cached.verify;
}

export interface GuardDeps {
  readonly verifierFor: (config: AccessConfig) => Verify;
  readonly logger: Logger;
}

function deny(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * Släpper igenom anropet (returnerar null) bara om Access-token är giltig och kommer från en
 * inbjuden adress, och om ett ändrande anrop klarar CSRF-kontrollen. Annars ett färdigt nej.
 * Inget innehåll från anropet loggas, bara skälet (KK-13-A).
 */
export async function guard(request: Request, env: AccessEnv, deps: GuardDeps): Promise<Response | null> {
  const config = readAccessConfig(env);
  if (config === null) {
    deps.logger.error("access.not_configured");
    return deny(503, "not_configured");
  }

  let result: AccessResult;
  try {
    result = await deps.verifierFor(config)(request.headers.get("cf-access-jwt-assertion"));
  } catch {
    deps.logger.error("access.keys_unavailable");
    return deny(503, "auth_unavailable");
  }
  if (!result.ok) {
    deps.logger.warn("access.denied", { kind: result.reason });
    return deny(401, "unauthorized");
  }

  if (!checkCsrf(request, config.appOrigin)) {
    deps.logger.warn("access.csrf_rejected");
    return deny(403, "forbidden");
  }
  return null;
}
