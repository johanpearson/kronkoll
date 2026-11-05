// API-workern. Nås bara via service binding från Pages Function (D-origin, workers_dev = false),
// men litar ändå inte på det: varje anrop kräver giltig Access-token (KK-2-B) och ändrande
// anrop dessutom CSRF-skydd (KK-29-B).
import { createEnableBankingConnector, createEnableBankingProvider, createJwtSigner } from "@kronkoll/adapter-enablebanking";
import { syncRunRepository } from "@kronkoll/adapter-d1";
import { manualSyncGate, type BankConnector, type BankDataProvider } from "@kronkoll/domain";
import { createLogger } from "@kronkoll/logging";
import { cachedVerifier, guard, type AccessEnv, type GuardDeps } from "./access.ts";
import { listAccounts, patchAccount } from "./accounts.ts";
import { deleteBudget, getBudget, putBudget } from "./budget.ts";
import { createCategory, listCategories, mergeCategory, patchCategory } from "./categories.ts";
import { deleteConnection } from "./connection-delete.ts";
import { getConnection, listConnections } from "./connection-list.ts";
import { addContribution, createGoal, getGoal, listGoals } from "./goals.ts";
import { deleteLoan, listLoans, putLoan } from "./loans.ts";
import { getIncome } from "./income.ts";
import { createLeavePeriod, deleteLeavePeriod, listLeavePeriods } from "./leave.ts";
import { getOverview } from "./overview.ts";
import { getPushConfig, subscribe, unsubscribe, type PushEnv } from "./push.ts";
import { getSettings, patchSettings } from "./settings.ts";
import { applyAll, createRule, deleteRule, getRuleMatches, listRules, patchRule } from "./rules.ts";
import { applyRule, setCategory } from "./set-category.ts";
import { isIncomeTypeRequest, setIncomeType } from "./set-income-type.ts";
import { getSplits, putSplits } from "./splits.ts";
import { putTransfer } from "./transfers.ts";
import { completeConnection, renewConnection, startConnection, type ConnectContext, type ConnectEnv } from "./connections.ts";
import { runSync, type SyncDeps, type SyncEnv } from "./sync.ts";
import { getTransaction, listTransactions } from "./transactions.ts";

export interface Env extends AccessEnv, SyncEnv, ConnectEnv, PushEnv {
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
  // Tiden tas före synken startar, så att alla dess körningar har startat då eller senare.
  const startedAt = context.sync.clock.now().toISOString();
  context.waitUntil(runSync(env, "manual", context.sync));
  return json({ status: "started", started_at: startedAt }, 202);
}

/**
 * GET /api/sync?since=…: hur det går för körningarna som startat sedan dess, så att appen kan visa att
 * synken pågår och hämta om när den är klar. `done` blir sant när minst en körning har startat och ingen
 * pågår längre.
 */
async function syncProgress(request: Request, env: Env): Promise<Response> {
  const since = new URL(request.url).searchParams.get("since") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/u.test(since)) return json({ error: "invalid_request" }, 400);
  try {
    const { started, running } = await syncRunRepository(env.DB).progressSince(since);
    return json({ started, running, done: started > 0 && running === 0 }, 200);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}

async function route(request: Request, env: Env, context: RouteContext, email: string): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (pathname === "/api/connections" && request.method === "GET") return listConnections(env, context.sync);

  const renewMatch = /^\/api\/connections\/([A-Za-z0-9_-]{1,64})\/renew$/u.exec(pathname);
  if (renewMatch?.[1]) {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, { allow: "POST" });
    return renewConnection(env, context, email, renewMatch[1]);
  }

  const connectionMatch = /^\/api\/connections\/([A-Za-z0-9_-]{1,64})$/u.exec(pathname);
  if (connectionMatch?.[1] && connectionMatch[1] !== "callback") {
    if (request.method === "GET") return getConnection(env, context.sync, connectionMatch[1]);
    if (request.method === "DELETE") return deleteConnection(request, env, context, connectionMatch[1]);
    return json({ error: "method_not_allowed" }, 405, { allow: "GET, DELETE" });
  }

  if (pathname === "/api/connections" || pathname === "/api/connections/callback") {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, { allow: pathname === "/api/connections" ? "GET, POST" : "POST" });
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
    if (request.method === "PATCH") {
      const body: unknown = await request.clone().json().catch(() => null);
      return isIncomeTypeRequest(body) ? setIncomeType(request, env, context.sync, txMatch[1]) : setCategory(request, env, context.sync, txMatch[1]);
    }
    return json({ error: "method_not_allowed" }, 405, { allow: "GET, PATCH" });
  }

  if (pathname === "/api/rules") {
    if (request.method === "GET") return listRules(env);
    if (request.method === "POST") return createRule(request, env, context.sync);
    return json({ error: "method_not_allowed" }, 405, { allow: "GET, POST" });
  }

  if (pathname === "/api/rules/apply-all") {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, { allow: "POST" });
    return applyAll(request, env);
  }

  const ruleMatchesMatch = /^\/api\/rules\/([A-Za-z0-9_-]{1,64})\/matches$/u.exec(pathname);
  if (ruleMatchesMatch?.[1]) {
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405, { allow: "GET" });
    return getRuleMatches(env, ruleMatchesMatch[1]);
  }

  const oneRuleMatch = /^\/api\/rules\/([A-Za-z0-9_-]{1,64})$/u.exec(pathname);
  if (oneRuleMatch?.[1]) {
    if (request.method === "PATCH") return patchRule(request, env, oneRuleMatch[1]);
    if (request.method === "DELETE") return deleteRule(env, oneRuleMatch[1]);
    return json({ error: "method_not_allowed" }, 405, { allow: "PATCH, DELETE" });
  }

  const ruleMatch = /^\/api\/rules\/([A-Za-z0-9_-]{1,64})\/apply$/u.exec(pathname);
  if (ruleMatch?.[1]) {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, { allow: "POST" });
    return applyRule(env, ruleMatch[1]);
  }

  const loanMatch = /^\/api\/loans\/([A-Za-z0-9_-]{1,64})$/u.exec(pathname);
  if (loanMatch?.[1]) {
    if (request.method === "PUT") return putLoan(request, env, loanMatch[1], context.sync);
    if (request.method === "DELETE") return deleteLoan(env, loanMatch[1]);
    return json({ error: "method_not_allowed" }, 405, { allow: "PUT, DELETE" });
  }

  if (pathname === "/api/loans") {
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405, { allow: "GET" });
    return listLoans(env, context.sync);
  }

  const contributionMatch = /^\/api\/goals\/([A-Za-z0-9_-]{1,64})\/contributions$/u.exec(pathname);
  if (contributionMatch?.[1]) {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, { allow: "POST" });
    return addContribution(request, env, contributionMatch[1], context.sync);
  }

  const goalMatch = /^\/api\/goals\/([A-Za-z0-9_-]{1,64})$/u.exec(pathname);
  if (goalMatch?.[1]) {
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405, { allow: "GET" });
    return getGoal(env, goalMatch[1], context.sync);
  }

  if (pathname === "/api/goals") {
    if (request.method === "GET") return listGoals(env, context.sync);
    if (request.method === "POST") return createGoal(request, env, context.sync);
    return json({ error: "method_not_allowed" }, 405, { allow: "GET, POST" });
  }
  const leaveMatch = /^\/api\/leave-periods\/([A-Za-z0-9_-]{1,64})$/u.exec(pathname);
  if (leaveMatch?.[1]) {
    if (request.method !== "DELETE") return json({ error: "method_not_allowed" }, 405, { allow: "DELETE" });
    return deleteLeavePeriod(env, leaveMatch[1]);
  }
  if (pathname === "/api/leave-periods") {
    if (request.method === "GET") return listLeavePeriods(env, context.sync);
    if (request.method === "POST") return createLeavePeriod(request, env, context.sync);
    return json({ error: "method_not_allowed" }, 405, { allow: "GET, POST" });
  }

  const budgetMatch = /^\/api\/budgets\/([A-Za-z0-9-]{1,16})$/u.exec(pathname);
  if (budgetMatch?.[1]) {
    if (request.method === "GET") return getBudget(env, budgetMatch[1], context.sync);
    if (request.method === "PUT") return putBudget(request, env, budgetMatch[1], context.sync);
    if (request.method === "DELETE") return deleteBudget(env, budgetMatch[1], context.sync);
    return json({ error: "method_not_allowed" }, 405, { allow: "GET, PUT, DELETE" });
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

  if (pathname === "/api/settings") {
    if (request.method === "GET") return getSettings(env, context.sync);
    if (request.method === "PATCH") return patchSettings(request, env, context.sync);
    return json({ error: "method_not_allowed" }, 405, { allow: "GET, PATCH" });
  }

  if (pathname === "/api/income") {
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405, { allow: "GET" });
    return getIncome(request, env, context.sync);
  }
  if (pathname === "/api/overview") {
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405, { allow: "GET" });
    return getOverview(request, env, context.sync);
  }

  if (pathname === "/api/categories") {
    if (request.method === "GET") return listCategories(env);
    if (request.method === "POST") return createCategory(request, env, context.sync);
    return json({ error: "method_not_allowed" }, 405, { allow: "GET, POST" });
  }

  const mergeMatch = /^\/api\/categories\/([A-Za-z0-9_-]{1,64})\/merge$/u.exec(pathname);
  if (mergeMatch?.[1]) {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, { allow: "POST" });
    return mergeCategory(request, env, mergeMatch[1]);
  }

  const categoryMatch = /^\/api\/categories\/([A-Za-z0-9_-]{1,64})$/u.exec(pathname);
  if (categoryMatch?.[1]) {
    if (request.method !== "PATCH") return json({ error: "method_not_allowed" }, 405, { allow: "PATCH" });
    return patchCategory(request, env, categoryMatch[1]);
  }

  if (pathname === "/api/transactions") {
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405, { allow: "GET" });
    return listTransactions(request, env, context.sync);
  }

  if (pathname === "/api/push") {
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405, { allow: "GET" });
    return getPushConfig(env);
  }

  if (pathname === "/api/push/subscriptions") {
    if (request.method === "POST") return subscribe(request, env, context.sync);
    if (request.method === "DELETE") return unsubscribe(request, env);
    return json({ error: "method_not_allowed" }, 405, { allow: "POST, DELETE" });
  }

  if (pathname === "/api/sync") {
    if (request.method === "GET") return syncProgress(request, env);
    if (request.method === "POST") return manualSync(env, context);
    return json({ error: "method_not_allowed" }, 405, { allow: "GET, POST" });
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
