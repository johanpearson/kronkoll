import type { D1Database } from "@cloudflare/workers-types";
import { accountRepository, connectionRepository, deriveKeys } from "@kronkoll/adapter-d1";
import { migratedDb, randomSecret } from "@kronkoll/adapter-d1/test-support";
import { fixedClock, ProviderError, type BankConnector } from "@kronkoll/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cachedVerifier, type GuardDeps } from "./access.ts";
import { handle, type Env, type RouteContext } from "./index.ts";
import { AUD, INVITED, ISSUER, ORIGIN, captureLogs, configuredEnv, createTestKey, jwksFetch, signToken, type TestKey } from "./test-support.ts";

let db: D1Database;
let dispose: () => Promise<void>;
let key: TestKey;
let guardDeps: GuardDeps;
const secret = randomSecret();
const SESSION_ID = "3f1d2c4b-0000-4000-8000-00000000abcd";

beforeAll(async () => {
  ({ db, dispose } = await migratedDb());
  key = await createTestKey("delete-key");
  const { fetchImpl } = jwksFetch(key);
  guardDeps = {
    verifierFor: () => cachedVerifier({ issuer: ISSUER, audience: AUD, allowedEmails: [INVITED], appOrigin: ORIGIN }, fetchImpl),
    logger: captureLogs().logger,
  };
});
afterAll(async () => {
  await dispose();
});

/** En påhittad Skandia-koppling (KK-13) med två konton, tre transaktioner och en uppdelning. */
beforeEach(async () => {
  await db.batch([db.prepare(`DELETE FROM transactions`), db.prepare(`DELETE FROM accounts`), db.prepare(`DELETE FROM bank_connections`)]);
  const keys = await deriveKeys(secret);
  const connections = connectionRepository(db, keys);
  await connections.create({ id: "c1", provider: "enablebanking", aspspName: "Skandia" });
  await connections.activate("c1", { sessionId: SESSION_ID, consentExpiresOn: "2027-05-01" });
  const accounts = accountRepository(db, keys);
  await accounts.upsertFromBank({ connectionId: "c1", providerUid: "u1", iban: null, name: "Privatkonto", type: "checking", balanceMinor: 100 }, () => "acc_1");
  await accounts.upsertFromBank({ connectionId: "c1", providerUid: "u2", iban: null, name: "Spar", type: "savings", balanceMinor: 200 }, () => "acc_2");
  await db.batch([
    db.prepare(
      `INSERT INTO transactions (id, account_id, fingerprint, status, last_seen_at, transaction_date, amount_minor) VALUES
       ('t1', 'acc_1', 'fp', 'booked', '2026-11-02', '2026-11-02', -100),
       ('t2', 'acc_1', 'fp', 'booked', '2026-11-02', '2026-11-02', -200),
       ('t3', 'acc_2', 'fp', 'booked', '2026-11-02', '2026-11-02', 300)`,
    ),
    db.prepare(`INSERT INTO transaction_splits (id, transaction_id, category_id, amount_minor) VALUES ('s1', 't2', 'mat', -200)`),
  ]);
});

function fakeConnector(error?: ProviderError) {
  const revoked: string[] = [];
  const connector: BankConnector = {
    startAuthorization: () => Promise.reject(new Error("används inte här")),
    createSession: () => Promise.reject(new Error("används inte här")),
    revokeSession(sessionId) {
      revoked.push(sessionId);
      return error ? Promise.reject(error) : Promise.resolve();
    },
  };
  return { connector, revoked };
}

async function call(path: string, init: { method?: string; connector?: BankConnector | null; env?: Partial<Env>; csrf?: boolean } = {}) {
  const logs = captureLogs();
  const context: RouteContext = {
    waitUntil: () => undefined,
    sync: { logger: logs.logger, clock: fixedClock("2026-11-15T10:00:00.000Z"), newId: () => "x", providerFor: () => null },
    connectorFor: () => (init.connector === undefined ? fakeConnector().connector : init.connector),
  };
  const headers = new Headers({ "cf-access-jwt-assertion": await signToken(key) });
  if (init.csrf !== false) {
    headers.set("origin", ORIGIN);
    headers.set("x-kronkoll", "1");
  }
  const response = await handle(new Request(`${ORIGIN}${path}`, { method: init.method ?? "DELETE", headers }), configuredEnv({ DB: db, SESSION_ENC_KEY: secret, ...init.env }), guardDeps, context);
  return { response, logs: logs.lines };
}

const left = async () =>
  db.prepare(`SELECT (SELECT count(*) FROM bank_connections) AS c, (SELECT count(*) FROM accounts) AS a, (SELECT count(*) FROM transactions) AS t, (SELECT count(*) FROM transaction_splits) AS s`).first();
const connection = async () => db.prepare(`SELECT status, session_id_enc IS NULL AS no_session FROM bank_connections WHERE id = 'c1'`).first();

describe("DELETE /api/connections/{id} (KK-11-A, KK-11-B)", () => {
  it("med purge: återkallar sessionen hos banken och raderar konton, transaktioner och uppdelningar, med kvittens", async () => {
    const bank = fakeConnector();
    const { response, logs } = await call("/api/connections/c1?purge=true", { connector: bank.connector });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revoked: true, deleted: { accounts: 2, transactions: 3, splits: 1 }, backup_expiry_days: 7 });
    expect(bank.revoked).toEqual([SESSION_ID]);
    expect(await left()).toEqual({ c: 0, a: 0, t: 0, s: 0 });
    expect(JSON.stringify(logs)).not.toContain(SESSION_ID);
  });

  it("utan purge: återkallar sessionen och raderar session-id, men behåller historiken", async () => {
    const bank = fakeConnector();
    const { response } = await call("/api/connections/c1?purge=false", { connector: bank.connector });
    expect(await response.json()).toEqual({ revoked: true, deleted: null, backup_expiry_days: 7 });
    expect(bank.revoked).toEqual([SESSION_ID]);
    expect(await connection()).toEqual({ status: "revoked", no_session: 1 });
    expect(await left()).toEqual({ c: 1, a: 2, t: 3, s: 1 });
  });

  it("en koppling som redan är återkallad kan raderas utan att banken anropas igen", async () => {
    await call("/api/connections/c1?purge=false");
    const bank = fakeConnector();
    const { response } = await call("/api/connections/c1?purge=true", { connector: bank.connector });
    expect(response.status).toBe(200);
    expect(bank.revoked).toEqual([]);
    expect(await left()).toEqual({ c: 0, a: 0, t: 0, s: 0 });
  });

  it("går det inte att återkalla hos banken ändras ingenting, så att man kan försöka igen", async () => {
    const { response } = await call("/api/connections/c1?purge=true", { connector: fakeConnector(new ProviderError("UNAVAILABLE")).connector });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "revoke_failed", code: "UNAVAILABLE" });
    expect(await connection()).toEqual({ status: "active", no_session: 0 });
    expect(await left()).toEqual({ c: 1, a: 2, t: 3, s: 1 });
  });

  it.each(["", "?purge=ja", "?purge=1"])("purge måste vara true eller false: %j ger 400", async (query) => {
    expect((await call(`/api/connections/c1${query}`)).response.status).toBe(400);
    expect(await left()).toEqual({ c: 1, a: 2, t: 3, s: 1 });
  });

  it("okänd koppling 404, utan nycklar eller bank 503, och CSRF krävs", async () => {
    expect((await call("/api/connections/finns-inte?purge=true")).response.status).toBe(404);
    expect((await call("/api/connections/c1?purge=true", { connector: null })).response.status).toBe(503);
    expect((await call("/api/connections/c1?purge=true", { env: { SESSION_ENC_KEY: undefined } })).response.status).toBe(503);
    expect((await call("/api/connections/c1?purge=true", { csrf: false })).response.status).toBe(403);
    expect(await left()).toEqual({ c: 1, a: 2, t: 3, s: 1 });
  });

  it("svarar 503 utan detaljer när databasen inte går att nå, och andra metoder ger 405", async () => {
    const broken = { prepare: () => { throw new Error("D1 nere"); } } as unknown as D1Database;
    expect((await call("/api/connections/c1?purge=true", { env: { DB: broken } })).response.status).toBe(503);
    const { response } = await call("/api/connections/c1", { method: "PUT" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, DELETE");
  });

  it("sidan om kopplingen säger hur mycket historik som raderas med den", async () => {
    const { response } = await call("/api/connections/c1", { method: "GET" });
    expect(await response.json()).toMatchObject({ history: { accounts: 2, transactions: 3, splits: 1 } });
  });
});
