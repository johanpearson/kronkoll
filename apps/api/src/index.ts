// API-workern. Nås bara via service binding från Pages Function (D-origin, workers_dev = false),
// men litar ändå inte på det: varje anrop kräver giltig Access-token (KK-2-B) och ändrande
// anrop dessutom CSRF-skydd (KK-29-B).
import { createEnableBankingConnector, createEnableBankingProvider, createJwtSigner } from "@kronkoll/adapter-enablebanking";
import { syncRunRepository } from "@kronkoll/adapter-d1";
import { manualSyncGate, type BankConnector, type BankDataProvider } from "@kronkoll/domain";
import { createLogger } from "@kronkoll/logging";
import { cachedVerifier, guard, type AccessEnv, type GuardDeps } from "./access.ts";
import { listAccounts, patchAccount } from "./accounts.ts";
import { getBudget, putBudget } from "./budget.ts";
import { listCategories } from "./categories.ts";
import { applyRule, setCategory } from "./set-category.ts";
import { getSplits, putSplits } from "./splits.ts";
import { putTransfer } from "./transfers.ts";
import { completeConnection, startConnection, type ConnectContext, type ConnectEnv } from "./connections.ts";
import { runSync, type SyncDeps, type SyncEnv } from "./sync.ts";
import { getTransaction, listTransactions } from "./transactions.ts";

export interface Env extends AccessEnv, SyncEnv, ConnectEnv {
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

/** Det en route behöver utöver miljön: att kunna fortsätta efter svaret, synken och banken. */
export interface RouteContext extends ConnectContext {
  readonly waitUntil: (promise: Promise<unknown>) => void;
}

/**
 * Manuell synk (KK-7-C): högst en gång per 15 minuter, räknat från start av senaste manuella
 * körningen. Synken körs i bakgrunden och svaret kommer direkt. Gränsen läses ur körningsloggen,
 * så ett par anrop i exakt samma ögonblick kan båda slippa igenom. Det är acceptabelt för en
 * enda användare, och knappen i appen stängs av medan synken pågår.
 */
async function manualSync(env: Env, context: RouteContext): Promise<Response> {
  if (!env.SESSION_ENC_KEY || context.sync.providerFor() === null) return json({ error: "not_configured" }, 503);
  let gate;
  try {
    gate = manualSyncGate(await syncRunRepository(env.DB).lastManualStartedAt(), context.sync.clock.now());
  } catch {
    return json({ error: "unavailable" }, 503);
  }
  if (!gate.allowed) {
    return json({ error: "too_soon", retry_after_s: gate.retryAfterSeconds }, 429, { "retry-after": String(gate.retryAfterSeconds) });
  }
  context.waitUntil(runSync(env, "manual", context.sync));
  return json({ status: "started" }, 202);
}

async function route(request: Request, env: Env, context: RouteContext, email: string): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (pathname === "/api/connections" || pathname === "/api/connections/callback") {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, { allow: "POST" });
    return pathname === "/api/connections" ? startConnection(request, env, context, email) : completeConnection(request, env, context, email);
  }

  const transferMatch = /^\/api\/transactions\/([A-Za-z0-9_-]{1,64})\/transfer$/u.exec(pathname);
  if (transferMatch?.[1]) {
    if (request.method !== "PUT") return json({ error: "method_not_allowed" }, 405, { allow: "PUT" });
    return putTransfer(request, env, transferMatch[1]);
  }

  const splitMatch = /^\/api\/transactions\/([A-Za-z0-9_-]{1,64})\/splits$/u.exec(pathname);
  if (splitMatch?.[1]) {
    if (request.method === "GET") return getSplits(env, splitMatch[1]);
    if (request.method === "PUT") return putSplits(request, env, context.sync, splitMatch[1]);
    return json({ error: "method_not_allowed" }, 405, { allow: "GET, PUT" });
  }

  const txMatch = /^\/api\/transactions\/([A-Za-z0-9_-]{1,64})$/u.exec(pathname);
  if (txMatch?.[1]) {
    if (request.method === "GET") return getTransaction(env, txMatch[1]);
    if (request.method === "PATCH") return setCategory(request, env, context.sync, txMatch[1]);
    return json({ error: "method_not_allowed" }, 405, { allow: "GET, PATCH" });
  }

  const ruleMatch = /^\/api\/rules\/([A-Za-z0-9_-]{1,64})\/apply$/u.exec(pathname);
  if (ruleMatch?.[1]) {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, { allow: "POST" });
    return applyRule(env, ruleMatch[1]);
  }

  const budgetMatch = /^\/api\/budgets\/([A-Za-z0-9-]{1,16})$/u.exec(pathname);
  if (budgetMatch?.[1]) {
    if (request.method === "GET") return getBudget(env, budgetMatch[1], context.sync);
    if (request.method === "PUT") return putBudget(request, env, budgetMatch[1], context.sync);
    return json({ error: "method_not_allowed" }, 405, { allow: "GET, PUT" });
  }

  const accountMatch = /^\/api\/accounts\/([A-Za-z0-9_-]{1,64})$/u.exec(pathname);
  if (accountMatch?.[1]) {
    if (request.method !== "PATCH") return json({ error: "method_not_allowed" }, 405, { allow: "PATCH" });
    return patchAccount(request, env, accountMatch[1]);
  }

  if (pathname === "/api/accounts") {
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405, { allow: "GET" });
    return listAccounts(env);
  }

  if (pathname === "/api/categories") {
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405, { allow: "GET" });
    return listCategories(env);
  }

  if (pathname === "/api/transactions") {
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405, { allow: "GET" });
    return listTransactions(request, env, context.sync);
  }

  if (pathname === "/api/sync") {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, { allow: "POST" });
    return manualSync(env, context);
  }

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

export async function handle(request: Request, env: Env, deps: GuardDeps, context: RouteContext): Promise<Response> {
  const access = await guard(request, env, deps);
  return access.allowed ? route(request, env, context, access.email) : access.response;
}

const defaultDeps: GuardDeps = {
  verifierFor: (config) => cachedVerifier(config),
  logger: createLogger((line) => {
    console.log(JSON.stringify(line));
  }),
};

/** Det Enable Banking-adaptrarna behöver, eller null när hemligheterna saknas. */
function enableBankingOptions(env: Env) {
  if (!env.EB_APP_ID || !env.EB_PRIVATE_KEY) return null;
  return {
    signer: createJwtSigner({ privateKeyPem: env.EB_PRIVATE_KEY, applicationId: env.EB_APP_ID, now: () => Date.now() }),
    // Anropas via en pil, så att fetch inte tappar sin this i Workern.
    fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
  };
}

function enableBankingFrom(env: Env): BankDataProvider | null {
  const options = enableBankingOptions(env);
  return options && createEnableBankingProvider(options);
}

function enableBankingConnectorFrom(env: Env): BankConnector | null {
  const options = enableBankingOptions(env);
  return options && createEnableBankingConnector(options);
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

/** Routernas beroenden i drift. */
export function routeContext(env: Env, ctx: ExecutionContext): RouteContext {
  return { waitUntil: ctx.waitUntil.bind(ctx), sync: syncDeps(env), connectorFor: () => enableBankingConnectorFrom(env) };
}

export default {
  fetch: (request, env, ctx) => handle(request, env, defaultDeps, routeContext(env, ctx)),
  // Cron Trigger "7 4,15 * * *" (UTC), två gånger per dygn (KK-7, D-sync).
  scheduled: (_controller, env, ctx) => {
    ctx.waitUntil(runSync(env, "cron", syncDeps(env)));
  },
} satisfies ExportedHandler<Env>;
