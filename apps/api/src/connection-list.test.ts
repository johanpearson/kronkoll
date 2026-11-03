import type { D1Database } from "@cloudflare/workers-types";
import { accountRepository, connectionRepository, deriveKeys } from "@kronkoll/adapter-d1";
import { migratedDb, randomSecret } from "@kronkoll/adapter-d1/test-support";
import { fixedClock } from "@kronkoll/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cachedVerifier, type GuardDeps } from "./access.ts";
import { handle, type Env, type RouteContext } from "./index.ts";
import { AUD, INVITED, ISSUER, ORIGIN, captureLogs, configuredEnv, createTestKey, jwksFetch, signToken, type TestKey } from "./test-support.ts";

let db: D1Database;
let dispose: () => Promise<void>;
let key: TestKey;
let guardDeps: GuardDeps;
const SESSION_ID = "3f1d2c4b-0000-4000-8000-00000000abcd";

beforeAll(async () => {
  ({ db, dispose } = await migratedDb());
  const keys = await deriveKeys(randomSecret());
  key = await createTestKey("connection-list-key");
  const { fetchImpl } = jwksFetch(key);
  guardDeps = {
    verifierFor: () => cachedVerifier({ issuer: ISSUER, audience: AUD, allowedEmails: [INVITED], appOrigin: ORIGIN }, fetchImpl),
    logger: captureLogs().logger,
  };
  // Påhittade kopplingar (KK-13): en aktiv med två konton, en som misslyckats två gånger, en avbruten.
  const connections = connectionRepository(db, keys);
  await connections.create({ id: "c1", provider: "enablebanking", aspspName: "Skandia" });
  await connections.activate("c1", { sessionId: SESSION_ID, consentExpiresOn: "2027-05-01" });
  await connections.recordSyncOutcome("c1", "ok", "2026-11-15T05:02:11.000Z");
  await connections.create({ id: "c2", provider: "enablebanking", aspspName: "Nordea" });
  await connections.activate("c2", { sessionId: SESSION_ID, consentExpiresOn: "2026-11-20" });
  await connections.recordSyncOutcome("c2", "failed", "2026-11-14T15:07:00.000Z");
  await connections.recordSyncOutcome("c2", "failed", "2026-11-15T04:07:00.000Z");
  await connections.create({ id: "c3", provider: "enablebanking", aspspName: "SBAB" });
  const accounts = accountRepository(db, keys);
  await accounts.upsertFromBank({ connectionId: "c1", providerUid: "u1", iban: null, name: "Privatkonto", type: "checking", balanceMinor: 0 }, () => "acc_1");
  await accounts.upsertFromBank({ connectionId: "c1", providerUid: "u2", iban: null, name: "Spar", type: "savings", balanceMinor: 0 }, () => "acc_2");
});
afterAll(async () => {
  await dispose();
});

async function call(env: Partial<Env> = {}) {
  const context: RouteContext = {
    waitUntil: () => undefined,
    sync: { logger: captureLogs().logger, clock: fixedClock("2026-11-15T10:00:00.000Z"), newId: () => "x", providerFor: () => null },
    connectorFor: () => null,
  };
  const headers = new Headers({ "cf-access-jwt-assertion": await signToken(key) });
  return handle(new Request(`${ORIGIN}/api/connections`, { headers }), configuredEnv({ DB: db, ...env }), guardDeps, context);
}

describe("GET /api/connections (#34, KK-7-A, KK-8-A)", () => {
  it("listar kopplingarna med samtycke, senaste synk, fel i rad och antal konton, utan avbrutna", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      items: [
        { id: "c1", bank: "Skandia", status: "active", consent_expires_on: "2027-05-01", consent_days_left: 167, last_success_at: "2026-11-15T05:02:11.000Z", consecutive_failures: 0, account_count: 2 },
        { id: "c2", bank: "Nordea", status: "active", consent_expires_on: "2026-11-20", consent_days_left: 5, last_success_at: null, consecutive_failures: 2, account_count: 0 },
      ],
    });
  });

  it("skickar aldrig session-id", async () => {
    expect(await (await call()).text()).not.toContain(SESSION_ID);
  });

  it("svarar 503 utan detaljer när databasen inte går att läsa", async () => {
    const broken = { prepare: () => { throw new Error("D1 nere"); } } as unknown as D1Database;
    const res = await call({ DB: broken });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
  });
});

async function get(path: string, method = "GET", env: Partial<Env> = {}) {
  const context: RouteContext = {
    waitUntil: () => undefined,
    sync: { logger: captureLogs().logger, clock: fixedClock("2026-11-15T10:00:00.000Z"), newId: () => "x", providerFor: () => null },
    connectorFor: () => null,
  };
  const headers = new Headers({ "cf-access-jwt-assertion": await signToken(key), origin: ORIGIN, "x-kronkoll": "1" });
  return handle(new Request(`${ORIGIN}${path}`, { method, headers }), configuredEnv({ DB: db, ...env }), guardDeps, context);
}

describe("GET /api/connections/{id} (#34, KK-7-A)", () => {
  it("ger kopplingen med konton och de senaste synkkörningarna, utan bankdata", async () => {
    await db
      .prepare(`INSERT INTO sync_runs (id, connection_id, kind, started_at, finished_at, status, new_count, updated_count, error_code) VALUES ('run-1', 'c1', 'manual', '2026-11-15T09:00:00.000Z', '2026-11-15T09:00:04.000Z', 'ok', 3, 1, NULL)`)
      .run();
    const res = await get("/api/connections/c1");
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body).toMatchObject({ id: "c1", bank: "Skandia", status: "active", consent_days_left: 167, account_count: 2 });
    expect(body.accounts).toEqual([
      { id: "acc_1", name: "Privatkonto", type: "checking", balance_minor: 0 },
      { id: "acc_2", name: "Spar", type: "savings", balance_minor: 0 },
    ]);
    expect(body.sync_runs).toEqual([
      { kind: "manual", status: "ok", started_at: "2026-11-15T09:00:00.000Z", finished_at: "2026-11-15T09:00:04.000Z", new_count: 3, updated_count: 1, error_code: null },
    ]);
    expect(JSON.stringify(body)).not.toContain(SESSION_ID);
  });

  it.each(["/api/connections/c3", "/api/connections/finns-inte"])("%s (avbruten eller okänd) ger 404", async (path) => {
    const res = await get(path);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("andra metoder ger 405, och callback-adressen är orörd", async () => {
    const res = await get("/api/connections/c1", "PUT");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, DELETE");
    expect((await get("/api/connections/callback")).headers.get("allow")).toBe("POST");
  });

  it("svarar 503 utan detaljer när databasen inte går att läsa", async () => {
    const broken = { prepare: () => { throw new Error("D1 nere"); } } as unknown as D1Database;
    expect((await get("/api/connections/c1", "GET", { DB: broken })).status).toBe(503);
  });
});
