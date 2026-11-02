// API-workern. Nås bara via service binding från Pages Function (D-origin, workers_dev = false),
// men litar ändå inte på det: varje anrop kräver giltig Access-token (KK-2-B) och ändrande
// anrop dessutom CSRF-skydd (KK-29-B).
import { createEnableBankingProvider, createJwtSigner } from "@kronkoll/adapter-enablebanking";
import type { BankDataProvider } from "@kronkoll/domain";
import { createLogger } from "@kronkoll/logging";
import { cachedVerifier, guard, type AccessEnv, type GuardDeps } from "./access.ts";
import { runSync, type SyncDeps, type SyncEnv } from "./sync.ts";

export interface Env extends AccessEnv, SyncEnv {
  /** Secret: Enable Bankings application id. */
  EB_APP_ID?: string | undefined;
  /** Secret: privat nyckel (PKCS#8 PEM) för att signera anrop till Enable Banking. */
  EB_PRIVATE_KEY?: string | undefined;
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

/** Svarar om databasen går att nå. Felet loggas inte och skickas inte vidare (KK-13). */
async function databaseReachable(db: D1Database): Promise<boolean> {
  try {
    await db.prepare("SELECT 1").first();
    return true;
  } catch {
    return false;
  }
}

async function route(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (pathname === "/api/health") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ error: "method_not_allowed" }, 405, { allow: "GET, HEAD" });
    }
    return (await databaseReachable(env.DB))
      ? json({ status: "ok", db: "ok" }, 200)
      : json({ status: "degraded", db: "unavailable" }, 503);
  }

  return json({ error: "not_found" }, 404);
}

export async function handle(request: Request, env: Env, deps: GuardDeps): Promise<Response> {
  return (await guard(request, env, deps)) ?? route(request, env);
}

const defaultDeps: GuardDeps = {
  verifierFor: (config) => cachedVerifier(config),
  logger: createLogger((line) => {
    console.log(JSON.stringify(line));
  }),
};

function enableBankingFrom(env: Env): BankDataProvider | null {
  if (!env.EB_APP_ID || !env.EB_PRIVATE_KEY) return null;
  return createEnableBankingProvider({
    signer: createJwtSigner({ privateKeyPem: env.EB_PRIVATE_KEY, applicationId: env.EB_APP_ID, now: () => Date.now() }),
    // Anropas via en pil, så att fetch inte tappar sin this i Workern.
    fetch: (input, init) => fetch(input, init),
  });
}

/** Synkens beroenden i drift: riktig klocka, slumpade id och Enable Banking om hemligheterna finns. */
export function syncDeps(env: Env): SyncDeps {
  return {
    logger: defaultDeps.logger,
    clock: { now: () => new Date() },
    newId: () => crypto.randomUUID(),
    providerFor: () => enableBankingFrom(env),
  };
}

export default {
  fetch: (request, env) => handle(request, env, defaultDeps),
  // Cron Trigger "7 4,15 * * *" (UTC), två gånger per dygn (KK-7, D-sync).
  scheduled: (_controller, env, ctx) => {
    ctx.waitUntil(runSync(env, "cron", syncDeps(env)));
  },
} satisfies ExportedHandler<Env>;
