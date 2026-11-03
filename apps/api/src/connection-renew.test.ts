import type { D1Database } from "@cloudflare/workers-types";
import { accountRepository, connectStateRepository, connectionRepository, deriveKeys, type Keys } from "@kronkoll/adapter-d1";
import { migratedDb, randomSecret } from "@kronkoll/adapter-d1/test-support";
import { fixedClock, ProviderError, type AuthorizationRequest, type BankConnector, type BankDataProvider } from "@kronkoll/domain";
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
  key = await createTestKey("renew-key");
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
const OLD_SESSION = "11111111-0000-4000-8000-000000000001";
const NEW_SESSION = "22222222-0000-4000-8000-000000000002";
const IBAN = "SE45 5000 0000 0583 9825 7466";
const NOW = "2026-11-20T10:05:00.000Z";

/** En utgången Skandia-koppling med ett konto och en transaktion från före samtycket gick ut. */
beforeEach(async () => {
  await db.batch([db.prepare(`DELETE FROM transactions`), db.prepare(`DELETE FROM accounts`), db.prepare(`DELETE FROM sync_runs`), db.prepare(`DELETE FROM bank_connections`)]);
  const connections = connectionRepository(db, keys);
  await connections.create({ id: "c1", provider: "enablebanking", aspspName: "Skandia" });
  await connections.activate("c1", { sessionId: OLD_SESSION, consentExpiresOn: "2026-11-10" });
  await connections.expire("c1");
  await accountRepository(db, keys).upsertFromBank({ connectionId: "c1", providerUid: "uid-gammal", iban: IBAN, name: "Privatkonto", type: "checking", balanceMinor: 100 }, () => "acc_1");
  await db
    .prepare(
      `INSERT INTO transactions (id, account_id, provider_tx_id, fingerprint, status, last_seen_at, transaction_date, booking_date, amount_minor, counterparty, counterparty_norm, description)
       VALUES ('gammal', 'acc_1', 'tx-1', 'fp', 'booked', '2026-11-08', '2026-11-08', '2026-11-08', -4500, '', '', 'ICA NARA, STOCKHOLM')`,
    )
    .run();
});

function fakeBank(options: { startError?: ProviderError; sessionError?: ProviderError; revokeError?: ProviderError } = {}) {
  const started: AuthorizationRequest[] = [];
  const revoked: string[] = [];
  const connector: BankConnector = {
    startAuthorization(request) {
      started.push(request);
      return options.startError ? Promise.reject(options.startError) : Promise.resolve({ url: "https://tilisy.enablebanking.com/welcome?x=1" });
    },
    createSession: () => (options.sessionError ? Promise.reject(options.sessionError) : Promise.resolve({ sessionId: NEW_SESSION, consentExpiresOn: "2027-05-19" })),
    revokeSession(sessionId) {
      revoked.push(sessionId);
      return options.revokeError ? Promise.reject(options.revokeError) : Promise.resolve();
    },
  };
  // Banken ger kontot ett nytt uid i den nya sessionen; IBAN känns igen (KK-8-B).
  const provider: BankDataProvider = {
    accounts: () => Promise.resolve([{ providerUid: "uid-ny", iban: IBAN, name: "Privatkonto", type: "checking", currency: "SEK" }]),
    balance: () => Promise.resolve(2000_00),
    transactions: () =>
      Promise.resolve({
        transactions: [
          // Samma köp som redan finns, och ett nytt i glappet sedan förra synken.
          { providerTxId: "tx-1", status: "booked", transactionDate: "2026-11-08", bookingDate: "2026-11-08", amountMinor: -4500, counterparty: "", description: "ICA NARA, STOCKHOLM" },
          { providerTxId: "tx-2", status: "booked", transactionDate: "2026-11-15", bookingDate: "2026-11-15", amountMinor: -12000, counterparty: "", description: "SL APP, STOCKHOLM" },
        ],
        continuationKey: null,
      }),
  };
  return { connector, provider, started, revoked };
}

let seq = 0;

async function call(path: string, init: { method?: string; body?: unknown; bank?: ReturnType<typeof fakeBank>; env?: Partial<Env> } = {}) {
  const bank = init.bank ?? fakeBank();
  const logs = captureLogs();
  const pending: Promise<unknown>[] = [];
  const context: RouteContext = {
    waitUntil: (p) => pending.push(p),
    sync: { logger: logs.logger, clock: fixedClock(NOW), newId: () => `id-${String(++seq)}`, providerFor: () => bank.provider },
    connectorFor: () => bank.connector,
  };
  const headers = new Headers({ "cf-access-jwt-assertion": await signToken(key), "content-type": "application/json", origin: ORIGIN, "x-kronkoll": "1" });
  const request = new Request(`${ORIGIN}${path}`, { method: init.method ?? "POST", headers, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
  const response = await handle(request, configuredEnv({ DB: db, SESSION_ENC_KEY: secret, APP_ORIGIN: ORIGIN, ...init.env }), guardDeps, context);
  await Promise.all(pending);
  return { response, logs: logs.lines, bank };
}

const status = async () => db.prepare(`SELECT status, consent_expires_on AS expires FROM bank_connections WHERE id = 'c1'`).first();
const counts = async () => db.prepare(`SELECT (SELECT count(*) FROM accounts) AS a, (SELECT count(*) FROM transactions) AS t`).first();
const issueState = async () => (await connectStateRepository(db, keys).issue({ connectionId: "c1", userId: INVITED, now: new Date("2026-11-20T10:00:00.000Z") })).state;

describe("POST /api/connections/{id}/renew (KK-8-B)", () => {
  it("startar BankID igen för samma bank och samma koppling", async () => {
    const { response, bank } = await call("/api/connections/c1/renew");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ redirect_url: "https://tilisy.enablebanking.com/welcome?x=1", connection_id: "c1" });
    expect(bank.started).toEqual([expect.objectContaining({ aspspName: "Skandia", country: "SE", redirectUrl: `${ORIGIN}/koppla/klar` })]);
  });

  it("återhoppet förnyar kopplingen, känner igen kontot, hämtar glappet utan dubbletter och återkallar den gamla sessionen", async () => {
    const state = await issueState();
    const bank = fakeBank();
    const { response, logs } = await call("/api/connections/callback", { body: { code: "kod-1", state }, bank });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ connection_id: "c1", accounts: 1, initial_sync: "started", renewed: true });
    expect(await status()).toEqual({ status: "active", expires: "2027-05-19" });
    expect(await connectionRepository(db, keys).sessionId("c1")).toBe(NEW_SESSION);
    expect(bank.revoked).toEqual([OLD_SESSION]);
    // Samma konto, det gamla köpet en gång och det nya från glappet.
    expect(await counts()).toEqual({ a: 1, t: 2 });
    expect(JSON.stringify(logs)).not.toContain(NEW_SESSION);
    expect(JSON.stringify(logs)).not.toContain(OLD_SESSION);
  });

  it("om banken inte ger en ny session ändras ingenting, och kopplingen med historik finns kvar", async () => {
    const state = await issueState();
    const { response } = await call("/api/connections/callback", { body: { code: "kod-1", state }, bank: fakeBank({ sessionError: new ProviderError("UNAVAILABLE") }) });
    expect(response.status).toBe(502);
    expect(await status()).toEqual({ status: "expired", expires: "2026-11-10" });
    expect(await counts()).toEqual({ a: 1, t: 1 });
  });

  it("om den gamla sessionen inte går att återkalla blir förnyelsen ändå klar", async () => {
    const state = await issueState();
    const { response } = await call("/api/connections/callback", { body: { code: "kod-1", state }, bank: fakeBank({ revokeError: new ProviderError("UNAVAILABLE") }) });
    expect(response.status).toBe(201);
    expect(await status()).toMatchObject({ status: "active" });
  });

  it("ett fel när BankID startas ändrar ingenting", async () => {
    const { response } = await call("/api/connections/c1/renew", { bank: fakeBank({ startError: new ProviderError("UNAVAILABLE") }) });
    expect(response.status).toBe(502);
    expect(await status()).toEqual({ status: "expired", expires: "2026-11-10" });
    expect(await counts()).toEqual({ a: 1, t: 1 });
  });

  it("okänd eller ofärdig koppling 404, utan nycklar 503, trasig databas 503 och andra metoder 405", async () => {
    await connectionRepository(db, keys).create({ id: "ny", provider: "enablebanking", aspspName: "SBAB" });
    expect((await call("/api/connections/finns-inte/renew")).response.status).toBe(404);
    expect((await call("/api/connections/ny/renew")).response.status).toBe(404);
    expect((await call("/api/connections/c1/renew", { env: { SESSION_ENC_KEY: undefined } })).response.status).toBe(503);
    const broken = { prepare: () => { throw new Error("D1 nere"); } } as unknown as D1Database;
    expect((await call("/api/connections/c1/renew", { env: { DB: broken } })).response.status).toBe(503);
    const { response } = await call("/api/connections/c1/renew", { method: "GET" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });
});
