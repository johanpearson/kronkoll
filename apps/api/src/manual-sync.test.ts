import type { D1Database } from "@cloudflare/workers-types";
import { accountRepository, connectionRepository, deriveKeys, type Keys } from "@kronkoll/adapter-d1";
import { migratedDb, randomSecret } from "@kronkoll/adapter-d1/test-support";
import { fixedClock, type BankDataProvider } from "@kronkoll/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cachedVerifier, type GuardDeps } from "./access.ts";
import { handle, type Env } from "./index.ts";
import type { SyncDeps } from "./sync.ts";
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
  key = await createTestKey("manual-sync-key");
  const { fetchImpl } = jwksFetch(key);
  guardDeps = {
    verifierFor: () => cachedVerifier({ issuer: ISSUER, audience: AUD, allowedEmails: [INVITED], appOrigin: ORIGIN }, fetchImpl),
    logger: captureLogs().logger,
  };
});
afterAll(async () => {
  await dispose();
});

const START = "2026-11-20T10:00:00.000Z";
const minutesAfter = (m: number) => new Date(new Date(START).getTime() + m * 60_000).toISOString();

let seq = 0;
const newId = () => `id-${String(++seq)}`;

const bank: BankDataProvider = {
  accounts: () => Promise.resolve([]),
  balance: () => Promise.resolve(1000),
  transactions: () => Promise.resolve({ transactions: [], continuationKey: null }),
};

beforeEach(async () => {
  await db.batch([db.prepare(`DELETE FROM sync_runs`), db.prepare(`DELETE FROM transactions`), db.prepare(`DELETE FROM accounts`), db.prepare(`DELETE FROM bank_connections`)]);
  const connections = connectionRepository(db, keys);
  await connections.create({ id: "c1", provider: "enablebanking", aspspName: "Skandia" });
  await connections.activate("c1", { sessionId: "3f1d2c4b-0000-4000-8000-00000000abcd", consentExpiresOn: "2027-04-30" });
  await accountRepository(db, keys).upsertFromBank({ connectionId: "c1", providerUid: "uid-1", iban: null, name: "Privatkonto", type: "checking", balanceMinor: null }, newId);
});

/** Ett anrop till workern med en bakgrundslista som testet kan vänta in. */
async function call(path: string, init: { method?: string; at?: string; env?: Partial<Env>; provider?: BankDataProvider | null; csrf?: boolean } = {}) {
  const pending: Promise<unknown>[] = [];
  const sync: SyncDeps = {
    logger: captureLogs().logger,
    clock: fixedClock(init.at ?? START),
    newId,
    providerFor: () => (init.provider === undefined ? bank : init.provider),
  };
  const headers = new Headers({ "cf-access-jwt-assertion": await signToken(key) });
  if (init.csrf !== false) {
    headers.set("origin", ORIGIN);
    headers.set("x-kronkoll", "1");
  }
  const response = await handle(new Request(`${ORIGIN}${path}`, { method: init.method ?? "POST", headers }), configuredEnv({ DB: db, SESSION_ENC_KEY: secret, ...init.env }), guardDeps, {
    waitUntil: (p) => pending.push(p),
    sync,
  });
  await Promise.all(pending);
  return response;
}

const manualRuns = async () => (await db.prepare(`SELECT started_at AS at FROM sync_runs WHERE kind = 'manual' ORDER BY at`).all<{ at: string }>()).results.map((r) => r.at);

describe("POST /api/sync (KK-7-C)", () => {
  it("startar en synk i bakgrunden och svarar 202", async () => {
    const res = await call("/api/sync");
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "started" });
    expect(await manualRuns()).toEqual([START]);
    expect(await db.prepare(`SELECT status FROM sync_runs`).first()).toEqual({ status: "ok" });
  });

  it("nekar en ny synk inom 15 minuter med 429 och hur länge man ska vänta", async () => {
    await call("/api/sync");
    const res = await call("/api/sync", { at: minutesAfter(6) });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("540");
    expect(await res.json()).toEqual({ error: "too_soon", retry_after_s: 540 });
    expect(await manualRuns()).toEqual([START]);
  });

  it("tillåter en ny synk när 15 minuter har gått", async () => {
    await call("/api/sync");
    const res = await call("/api/sync", { at: minutesAfter(15) });
    expect(res.status).toBe(202);
    expect(await manualRuns()).toEqual([START, minutesAfter(15)]);
  });

  it("schemalagda körningar räknas inte mot gränsen", async () => {
    await db.prepare(`INSERT INTO sync_runs (id, connection_id, kind, started_at, status) VALUES ('cron-1', 'c1', 'cron', ?, 'ok')`).bind(minutesAfter(-2)).run();
    expect((await call("/api/sync")).status).toBe(202);
  });

  it("svarar 503 när synken inte är konfigurerad, utan att starta något eller använda gränsen", async () => {
    const res = await call("/api/sync", { provider: null });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "not_configured" });
    expect(await manualRuns()).toEqual([]);
    expect((await call("/api/sync")).status).toBe(202);
  });

  it("svarar 503 utan feldetaljer när databasen inte går att läsa", async () => {
    const broken = { prepare: () => { throw new Error("D1 nere"); } } as unknown as D1Database;
    const res = await call("/api/sync", { env: { DB: broken } });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
  });

  it("andra metoder ger 405", async () => {
    const res = await call("/api/sync", { method: "GET" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("kräver CSRF-skydd: utan header startas ingen synk", async () => {
    const res = await call("/api/sync", { csrf: false });
    expect(res.status).toBe(403);
    expect(await manualRuns()).toEqual([]);
  });
});
