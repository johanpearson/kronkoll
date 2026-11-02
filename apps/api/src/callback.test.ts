import type { D1Database } from "@cloudflare/workers-types";
import { connectStateRepository, connectionRepository, deriveKeys, type Keys } from "@kronkoll/adapter-d1";
import { migratedDb, randomSecret } from "@kronkoll/adapter-d1/test-support";
import { fixedClock, ProviderError, type BankConnector, type BankDataProvider } from "@kronkoll/domain";
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
  key = await createTestKey("callback-key");
  const { fetchImpl } = jwksFetch(key);
  guardDeps = {
    verifierFor: () => cachedVerifier({ issuer: ISSUER, audience: AUD, allowedEmails: [INVITED], appOrigin: ORIGIN }, fetchImpl),
    logger: captureLogs().logger,
  };
});
afterAll(async () => {
  await dispose();
});

// Påhittade värden, formade som Enable Bankings (KK-13).
const SESSION_ID = "3f1d2c4b-0000-4000-8000-00000000abcd";
const CODE = "kod-0f9e8d7c";
const IBAN = "SE45 5000 0000 0583 9825 7466";
const NOW = "2026-11-20T10:05:00.000Z";

let seq = 0;
const newId = () => `id-${String(++seq)}`;

let state: string;
beforeEach(async () => {
  await db.batch([db.prepare(`DELETE FROM sync_runs`), db.prepare(`DELETE FROM bank_connections`)]);
  await connectionRepository(db, keys).create({ id: "pending", provider: "enablebanking", aspspName: "SBAB" });
  ({ state } = await connectStateRepository(db, keys).issue({ connectionId: "pending", userId: INVITED, now: new Date("2026-11-20T10:00:00.000Z") }));
  // En annan, redan aktiv koppling som inte ska synkas av callbacken.
  await connectionRepository(db, keys).create({ id: "other", provider: "enablebanking", aspspName: "Skandia" });
  await connectionRepository(db, keys).activate("other", { sessionId: "annan-session", consentExpiresOn: "2027-04-30" });
});

function fakeBank(options: { sessionError?: ProviderError; accountsError?: ProviderError; consentExpiresOn?: string | null } = {}) {
  const codes: string[] = [];
  const connector: BankConnector = {
    startAuthorization: () => Promise.reject(new Error("används inte här")),
    createSession(code) {
      codes.push(code);
      if (options.sessionError) return Promise.reject(options.sessionError);
      return Promise.resolve({ sessionId: SESSION_ID, consentExpiresOn: options.consentExpiresOn === undefined ? "2027-05-19" : options.consentExpiresOn });
    },
  };
  const provider: BankDataProvider = {
    accounts(sessionId) {
      if (options.accountsError) return Promise.reject(options.accountsError);
      expect(sessionId).toBe(SESSION_ID);
      return Promise.resolve([
        { providerUid: "uid-spar", iban: IBAN, name: "Sparkonto", type: "savings", currency: "SEK" },
        { providerUid: "uid-lan", iban: null, name: "Bolån", type: "loan", currency: "SEK" },
      ]);
    },
    balance: () => Promise.resolve(10_000_00),
    transactions: () =>
      Promise.resolve({
        transactions: [{ providerTxId: "t1", status: "booked", transactionDate: "2026-11-18", bookingDate: "2026-11-18", amountMinor: 50_000, counterparty: "INSÄTTNING", description: "" }],
        continuationKey: null,
      }),
  };
  return { connector, provider, codes };
}

async function call(init: { body?: unknown; bank?: ReturnType<typeof fakeBank>; token?: string; csrf?: boolean; env?: Partial<Env>; noBank?: boolean } = {}) {
  const bank = init.bank ?? fakeBank();
  const logs = captureLogs();
  const pending: Promise<unknown>[] = [];
  const context: RouteContext = {
    waitUntil: (p) => pending.push(p),
    sync: { logger: logs.logger, clock: fixedClock(NOW), newId, providerFor: () => (init.noBank ? null : bank.provider) },
    connectorFor: () => (init.noBank ? null : bank.connector),
  };
  const headers = new Headers({ "cf-access-jwt-assertion": init.token ?? (await signToken(key)), "content-type": "application/json" });
  if (init.csrf !== false) {
    headers.set("origin", ORIGIN);
    headers.set("x-kronkoll", "1");
  }
  const body = init.body === undefined ? JSON.stringify({ code: CODE, state }) : typeof init.body === "string" ? init.body : JSON.stringify(init.body);
  const response = await handle(new Request(`${ORIGIN}/api/connections/callback`, { method: "POST", headers, body }), configuredEnv({ DB: db, SESSION_ENC_KEY: secret, ...init.env }), guardDeps, context);
  await Promise.all(pending);
  return { response, logs: logs.lines, bank };
}

const connection = async (id = "pending") =>
  db.prepare(`SELECT status, consent_expires_on AS expires FROM bank_connections WHERE id = ?`).bind(id).first<{ status: string; expires: string | null }>();

describe("POST /api/connections/callback (KK-5-C, KK-29-A, F-koppla)", () => {
  it("skapar sessionen, sparar kontona maskerade och startar första hämtningen för den nya kopplingen", async () => {
    const { response } = await call();
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ connection_id: "pending", accounts: 2, initial_sync: "started" });

    expect(await connection()).toEqual({ status: "active", expires: "2027-05-19" });
    expect(await connectionRepository(db, keys).sessionId("pending")).toBe(SESSION_ID);
    const accounts = await db.prepare(`SELECT display_name AS name, type, iban_hash AS hash FROM accounts WHERE connection_id = 'pending' ORDER BY type`).all<{ name: string; type: string; hash: string | null }>();
    expect(accounts.results.map((a) => [a.name, a.type])).toEqual([["Bolån", "loan"], ["Sparkonto ••7466", "savings"]]);

    const runs = await db.prepare(`SELECT connection_id AS c, kind, status FROM sync_runs`).all();
    expect(runs.results).toEqual([{ c: "pending", kind: "initial", status: "ok" }]);
    expect((await db.prepare(`SELECT count(*) AS n FROM transactions`).first<{ n: number }>())?.n).toBe(2);
  });

  it("sparar ingen klartext av session-id eller IBAN (KK-11-C)", async () => {
    await call();
    const dump = JSON.stringify([
      (await db.prepare(`SELECT * FROM bank_connections`).all()).results,
      (await db.prepare(`SELECT * FROM accounts`).all()).results,
    ]);
    for (const secretValue of [SESSION_ID, IBAN, IBAN.replace(/\s/gu, ""), CODE]) expect(dump).not.toContain(secretValue);
  });

  it("en bank som inte anger samtyckets slut ger en koppling utan slutdatum", async () => {
    await call({ bank: fakeBank({ consentExpiresOn: null }) });
    expect(await connection()).toEqual({ status: "active", expires: null });
  });

  it("ett state som redan använts avvisas med 400 och ingen ny session skapas (KK-29-A)", async () => {
    await call();
    const second = await call();
    expect(second.response.status).toBe(400);
    expect(await second.response.json()).toEqual({ error: "invalid_state" });
    expect(second.bank.codes).toEqual([]);
  });

  it.each([
    ["ett manipulerat state", () => ({ code: CODE, state: `${state}x` })],
    ["ett state från en annan koppling", () => ({ code: CODE, state: "0".repeat(32) + "." + "A".repeat(43) })],
  ])("%s avvisas med 400, och kopplingen förblir väntande", async (_, body) => {
    const { response, bank } = await call({ body: body() });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_state" });
    expect(bank.codes).toEqual([]);
    expect(await connection()).toMatchObject({ status: "pending_auth" });
  });

  it("ett state som har gått ut avvisas med 400", async () => {
    await db.prepare(`UPDATE connect_states SET expires_at = '2026-11-20T10:04:59.999Z'`).run();
    const { response, bank } = await call();
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_state" });
    expect(bank.codes).toEqual([]);
  });

  it("ett state utfärdat åt någon annan avvisas, även om den andra också är inbjuden", async () => {
    await db.prepare(`UPDATE connect_states SET user_id = 'annan@example.se'`).run();
    const { response } = await call();
    expect(response.status).toBe(400);
  });

  it.each([
    ["inte JSON", "{"],
    ["kod saknas", () => ({ state })],
    ["state saknas", { code: CODE }],
    ["för lång kod", () => ({ code: "x".repeat(2049), state })],
  ])("en begäran med %s avvisas med 400 utan att förbruka state", async (_, body) => {
    const { response, bank } = await call({ body: typeof body === "function" ? body() : body });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(bank.codes).toEqual([]);
    expect((await call()).response.status).toBe(201);
  });

  it.each([
    ["sessionen inte kan skapas", fakeBank({ sessionError: new ProviderError("FAILED") }), "EB_FAILED"],
    ["kontona inte kan hämtas", fakeBank({ accountsError: new ProviderError("UNAVAILABLE") }), "EB_UNAVAILABLE"],
  ])("om %s svarar den 502 och tar bort den väntande kopplingen", async (_, bank, errorCode) => {
    const { response, logs } = await call({ bank });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "bank_error" });
    expect(await connection()).toBeNull();
    expect(logs.map((l) => [l.event, l.fields.error_code])).toEqual([["connect.failed", errorCode]]);
  });

  it("svarar 503 när banken inte är konfigurerad, utan att förbruka state", async () => {
    const { response } = await call({ noBank: true });
    expect(response.status).toBe(503);
    expect((await call()).response.status).toBe(201);
  });

  it("loggarna innehåller varken kod, state, session-id eller e-post (KK-13-A)", async () => {
    const { logs } = await call();
    const text = JSON.stringify(logs);
    for (const forbidden of [CODE, state, SESSION_ID, INVITED]) expect(text).not.toContain(forbidden);
    expect(logs.map((l) => l.event)).toContain("connect.completed");
  });

  it("kräver CSRF-skydd: utan header förbrukas inget state (KK-29-B)", async () => {
    const { response } = await call({ csrf: false });
    expect(response.status).toBe(403);
    expect((await call()).response.status).toBe(201);
  });
});
