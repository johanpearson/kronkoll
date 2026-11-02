// Koppla en bank (#26, flödet F-koppla, KK-5, KK-29-A). Starten skapar en väntande koppling och
// ett engångs-state som är bundet till den inloggade, och ger bankens inloggningsadress. Banken
// skickar sedan användaren tillbaka till appens /koppla/klar med kod och state, och callbacken
// gör kopplingen klar.
import { accountRepository, connectStateRepository, connectionRepository, deriveKeys } from "@kronkoll/adapter-d1";
import { classifyProviderFailure, ProviderError, type BankConnector } from "@kronkoll/domain";
import { runSync, type SyncDeps } from "./sync.ts";

export interface ConnectEnv {
  DB: D1Database;
  SESSION_ENC_KEY?: string | undefined;
  APP_ORIGIN?: string | undefined;
}

export interface ConnectContext {
  readonly sync: SyncDeps;
  /** Banken att koppla mot, eller null när dess hemligheter saknas. */
  readonly connectorFor: () => BankConnector | null;
}

const MAX_NAME_LENGTH = 100;
const COUNTRY = /^[A-Z]{2}$/u;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

/** Bankens namn och land ur begäran, eller null om något saknas eller ser fel ut. */
async function readAspsp(request: Request): Promise<{ name: string; country: string } | null> {
  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== "object" || body === null || !("aspsp" in body)) return null;
  const { aspsp } = body;
  if (typeof aspsp !== "object" || aspsp === null || !("name" in aspsp) || !("country" in aspsp)) return null;
  const name = typeof aspsp.name === "string" ? aspsp.name.trim() : "";
  const country = typeof aspsp.country === "string" ? aspsp.country : "";
  return name !== "" && name.length <= MAX_NAME_LENGTH && COUNTRY.test(country) ? { name, country } : null;
}

export async function startConnection(request: Request, env: ConnectEnv, context: ConnectContext, email: string): Promise<Response> {
  const { logger, clock, newId } = context.sync;
  const connector = context.connectorFor();
  const keys = connector && env.SESSION_ENC_KEY && env.APP_ORIGIN ? await deriveKeys(env.SESSION_ENC_KEY).catch(() => null) : null;
  if (!connector || !keys || !env.APP_ORIGIN) return json({ error: "not_configured" }, 503);

  const aspsp = await readAspsp(request);
  if (!aspsp) return json({ error: "invalid_request" }, 400);

  const connections = connectionRepository(env.DB, keys);
  const connectionId = newId();
  try {
    await connections.create({ id: connectionId, provider: "enablebanking", aspspName: aspsp.name });
    const { state, expiresAt } = await connectStateRepository(env.DB, keys).issue({ connectionId, userId: email, now: clock.now() });
    const { url } = await connector.startAuthorization({ aspspName: aspsp.name, country: aspsp.country, state, redirectUrl: `${env.APP_ORIGIN}/koppla/klar` });
    logger.info("connect.started", { connection_id: connectionId });
    return json({ redirect_url: url, state_expires_at: expiresAt, connection_id: connectionId }, 200);
  } catch (error) {
    // Lämna ingen halv koppling kvar. Raderingen tar även med kopplingens state.
    await connections.delete(connectionId).catch(() => undefined);
    const errorCode = error instanceof ProviderError ? classifyProviderFailure(error.code).errorCode : "FAILED";
    logger.warn("connect.failed", { connection_id: connectionId, error_code: errorCode });
    return error instanceof ProviderError ? json({ error: "bank_error" }, 502) : json({ error: "unavailable" }, 503);
  }
}

const MAX_CODE_LENGTH = 2048;
const MAX_STATE_LENGTH = 200;

/** Kod och state ur bankens återhopp, eller null om något saknas eller ser fel ut. */
async function readCallback(request: Request): Promise<{ code: string; state: string } | null> {
  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== "object" || body === null || !("code" in body) || !("state" in body)) return null;
  const { code, state } = body;
  if (typeof code !== "string" || typeof state !== "string") return null;
  return code !== "" && code.length <= MAX_CODE_LENGTH && state !== "" && state.length <= MAX_STATE_LENGTH ? { code, state } : null;
}

/**
 * Användaren kommer tillbaka från banken (POST /api/connections/callback). State måste vara
 * äkta, oanvänt, inte utgånget och utfärdat åt den inloggade (KK-29-A). Annars 400 och ingen
 * session skapas. Därefter skapas sessionen, kontona sparas maskerade (KK-11-C) och första
 * hämtningen startas i bakgrunden för just den här kopplingen (KK-5-C).
 */
export async function completeConnection(
  request: Request,
  env: ConnectEnv,
  context: ConnectContext & { readonly waitUntil: (promise: Promise<unknown>) => void },
  email: string,
): Promise<Response> {
  const { logger, clock, newId } = context.sync;
  const connector = context.connectorFor();
  const provider = context.sync.providerFor();
  const keys = connector && provider && env.SESSION_ENC_KEY ? await deriveKeys(env.SESSION_ENC_KEY).catch(() => null) : null;
  if (!connector || !provider || !keys) return json({ error: "not_configured" }, 503);

  const callback = await readCallback(request);
  if (!callback) return json({ error: "invalid_request" }, 400);

  let consumed;
  try {
    consumed = await connectStateRepository(env.DB, keys).consume({ state: callback.state, userId: email, now: clock.now() });
  } catch {
    return json({ error: "unavailable" }, 503);
  }
  if (!consumed) {
    logger.warn("connect.invalid_state");
    return json({ error: "invalid_state" }, 400);
  }

  const { connectionId } = consumed;
  const connections = connectionRepository(env.DB, keys);
  try {
    const session = await connector.createSession(callback.code);
    const bankAccounts = await provider.accounts(session.sessionId);
    await connections.activate(connectionId, session);
    const accounts = accountRepository(env.DB, keys);
    for (const account of bankAccounts) {
      await accounts.upsertFromBank(
        { connectionId, providerUid: account.providerUid, iban: account.iban, name: account.name, type: account.type, balanceMinor: null },
        newId,
      );
    }
    context.waitUntil(runSync(env, "initial", context.sync, connectionId));
    logger.info("connect.completed", { connection_id: connectionId, count: bankAccounts.length });
    return json({ connection_id: connectionId, accounts: bankAccounts.length, initial_sync: "started" }, 201);
  } catch (error) {
    // Ingen halv koppling: användaren får börja om med en ny.
    await connections.delete(connectionId).catch(() => undefined);
    const errorCode = error instanceof ProviderError ? classifyProviderFailure(error.code).errorCode : "FAILED";
    logger.warn("connect.failed", { connection_id: connectionId, error_code: errorCode });
    return error instanceof ProviderError ? json({ error: "bank_error" }, 502) : json({ error: "unavailable" }, 503);
  }
}
