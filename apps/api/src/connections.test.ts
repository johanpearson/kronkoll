import type { D1Database } from "@cloudflare/workers-types";
import { connectStateRepository, deriveKeys, type Keys } from "@kronkoll/adapter-d1";
import { migratedDb, randomSecret } from "@kronkoll/adapter-d1/test-support";
import { fixedClock, ProviderError, type AuthorizationRequest, type BankConnector } from "@kronkoll/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cachedVerifier, type GuardDeps } from "./access.ts";
import { handle, type Env, type RouteContext } from "./index.ts";
import { AUD, INVITED, ISSUER, ORIGIN, captureLogs, configuredEnv, createTestKey, jwksFetch, signToken, type TestKey } from "./test-support.ts";

let db: D1Database;
let dispose: () => Promise<void>;
let secret: string;
let keys: Keys;
let key: TestKey;
let guardDeps: GuardDeps;

beforeAll(async () => {
  ({ db, dispose } = await migratedDb());
  secret = randomSecret();
  keys = await deriveKeys(secret);
  key = await createTestKey("connections-key");
  const { fetchImpl } = jwksFetch(key);
  guardDeps = {
    verifierFor: () => cachedVerifier({ issuer: ISSUER, audience: AUD, allowedEmails: [INVITED], appOrigin: ORIGIN }, fetchImpl),
    logger: captureLogs().logger,
  };
});
afterAll(async () => {
  await dispose();
});
beforeEach(async () => {
  await db.prepare(`DELETE FROM bank_connections`).run();
});

const NOW = "2026-11-20T10:00:00.000Z";
let seq = 0;
const newId = () => `conn-${String(++seq)}`;

/** En bank som minns vad den fick, och kan svara med ett fel. */
function fakeConnector(error?: ProviderError) {
  const requests: AuthorizationRequest[] = [];
  const connector: BankConnector = {
    startAuthorization(request) {
      requests.push(request);
      return error ? Promise.reject(error) : Promise.resolve({ url: "https://tilisy.enablebanking.com/welcome?x=1" });
    },
    createSession: () => Promise.reject(new Error("används inte här")),
  };
  return { connector, requests };
}

async function call(init: { method?: string; body?: unknown; csrf?: boolean; env?: Partial<Env>; connector?: BankConnector | null } = {}) {
  const logs = captureLogs();
  const context: RouteContext = {
    waitUntil: () => undefined,
    sync: { logger: logs.logger, clock: fixedClock(NOW), newId, providerFor: () => null },
    connectorFor: () => (init.connector === undefined ? fakeConnector().connector : init.connector),
  };
  const headers = new Headers({ "cf-access-jwt-assertion": await signToken(key), "content-type": "application/json" });
  if (init.csrf !== false) {
    headers.set("origin", ORIGIN);
    headers.set("x-kronkoll", "1");
  }
  const body = init.body === undefined ? JSON.stringify({ aspsp: { name: "Skandia", country: "SE" }, psu_type: "personal" }) : typeof init.body === "string" ? init.body : JSON.stringify(init.body);
  const method = init.method ?? "POST";
  const request = new Request(`${ORIGIN}/api/connections`, { method, headers, ...(method === "GET" ? {} : { body }) });
  const response = await handle(request, configuredEnv({ DB: db, SESSION_ENC_KEY: secret, ...init.env }), guardDeps, context);
  return { response, logs: logs.lines };
}

const connections = async () => (await db.prepare(`SELECT id, provider, aspsp_name AS bank, status FROM bank_connections`).all()).results;
const stateCount = async () => (await db.prepare(`SELECT count(*) AS n FROM connect_states`).first<{ n: number }>())?.n;

describe("POST /api/connections (KK-5, KK-29-A, F-koppla)", () => {
  it("skapar en väntande koppling, ett engångs-state och ger bankens inloggningsadress", async () => {
    const bank = fakeConnector();
    const { response } = await call({ connector: bank.connector });
    expect(response.status).toBe(200);
    const body = await response.json<{ redirect_url: string; state_expires_at: string; connection_id: string }>();
    expect(body).toEqual({ redirect_url: "https://tilisy.enablebanking.com/welcome?x=1", state_expires_at: "2026-11-20T10:15:00.000Z", connection_id: expect.any(String) as string });
    expect(await connections()).toEqual([{ id: body.connection_id, provider: "enablebanking", bank: "Skandia", status: "pending_auth" }]);
    expect(bank.requests).toEqual([{ aspspName: "Skandia", country: "SE", state: expect.any(String) as string, redirectUrl: `${ORIGIN}/koppla/klar` }]);
  });

  it("state som skickas till banken är bundet till den inloggade och till kopplingen", async () => {
    const bank = fakeConnector();
    const { response } = await call({ connector: bank.connector });
    const { connection_id } = await response.json<{ connection_id: string }>();
    const state = bank.requests[0]?.state ?? "";
    const repo = connectStateRepository(db, keys);
    expect(await repo.consume({ state, userId: "annan@example.se", now: new Date(NOW) })).toBeNull();
    expect(await repo.consume({ state, userId: INVITED, now: new Date(NOW) })).toEqual({ connectionId: connection_id });
  });

  it.each([
    ["inte JSON", "{"],
    ["ingen bank", {}],
    ["tomt namn", { aspsp: { name: "  ", country: "SE" } }],
    ["för långt namn", { aspsp: { name: "x".repeat(101), country: "SE" } }],
    ["fel land", { aspsp: { name: "Skandia", country: "se" } }],
    ["land saknas", { aspsp: { name: "Skandia" } }],
  ])("avvisar en begäran med %s med 400 och skapar ingenting", async (_, body) => {
    const bank = fakeConnector();
    const { response } = await call({ body, connector: bank.connector });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(await connections()).toEqual([]);
    expect(bank.requests).toEqual([]);
  });

  it("svarar 503 utan detaljer om databasen inte går att skriva till", async () => {
    const broken = { prepare: () => { throw new Error("D1 nere"); }, batch: () => Promise.reject(new Error("D1 nere")) } as unknown as D1Database;
    const bank = fakeConnector();
    const { response, logs } = await call({ env: { DB: broken }, connector: bank.connector });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
    expect(bank.requests).toEqual([]);
    expect(logs.map((l) => [l.event, l.fields.error_code])).toEqual([["connect.failed", "FAILED"]]);
  });

  it.each([
    ["bankens hemligheter saknas", { connector: null }],
    ["SESSION_ENC_KEY saknas", { env: { SESSION_ENC_KEY: undefined } }],
    ["SESSION_ENC_KEY är ogiltig", { env: { SESSION_ENC_KEY: "inte-base64-!!" } }],
    ["APP_ORIGIN saknas", { env: { APP_ORIGIN: undefined } }],
  ] as const)("svarar 503 när %s, och skapar ingenting", async (_, init) => {
    const { response } = await call(init);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "not_configured" });
    expect(await connections()).toEqual([]);
  });

  it("om banken svarar med fel tas den väntande kopplingen och dess state bort, och svaret är 502", async () => {
    const { response, logs } = await call({ connector: fakeConnector(new ProviderError("UNAVAILABLE")).connector });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "bank_error" });
    expect(await connections()).toEqual([]);
    expect(await stateCount()).toBe(0);
    expect(logs.map((l) => [l.event, l.fields.error_code])).toEqual([["connect.failed", "EB_UNAVAILABLE"]]);
  });

  it("loggar starten utan e-post eller state (KK-13-A)", async () => {
    const bank = fakeConnector();
    const { logs } = await call({ connector: bank.connector });
    expect(logs.map((l) => l.event)).toEqual(["connect.started"]);
    const text = JSON.stringify(logs);
    expect(text).not.toContain(INVITED);
    expect(text).not.toContain(bank.requests[0]?.state ?? "x");
  });

  it("andra metoder ger 405", async () => {
    const { response } = await call({ method: "GET" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("kräver CSRF-skydd: utan header skapas ingenting (KK-29-B)", async () => {
    const { response } = await call({ csrf: false });
    expect(response.status).toBe(403);
    expect(await connections()).toEqual([]);
  });
});
