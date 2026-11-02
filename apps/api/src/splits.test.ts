import type { D1Database } from "@cloudflare/workers-types";
import { accountRepository, connectionRepository, deriveKeys } from "@kronkoll/adapter-d1";
import { migratedDb, randomSecret } from "@kronkoll/adapter-d1/test-support";
import { fixedClock } from "@kronkoll/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cachedVerifier, type GuardDeps } from "./access.ts";
import { handle, type RouteContext } from "./index.ts";
import { AUD, INVITED, ISSUER, ORIGIN, captureLogs, configuredEnv, createTestKey, jwksFetch, signToken, type TestKey } from "./test-support.ts";

let db: D1Database;
let dispose: () => Promise<void>;
let key: TestKey;
let guardDeps: GuardDeps;

beforeAll(async () => {
  ({ db, dispose } = await migratedDb());
  const keys = await deriveKeys(randomSecret());
  key = await createTestKey("splits-key");
  const { fetchImpl } = jwksFetch(key);
  guardDeps = {
    verifierFor: () => cachedVerifier({ issuer: ISSUER, audience: AUD, allowedEmails: [INVITED], appOrigin: ORIGIN }, fetchImpl),
    logger: captureLogs().logger,
  };
  await connectionRepository(db, keys).create({ id: "c1", provider: "enablebanking", aspspName: "Skandia" });
  await accountRepository(db, keys).upsertFromBank({ connectionId: "c1", providerUid: "u1", iban: null, name: "Privatkonto", type: "checking", balanceMinor: 0 }, () => "acc_1");
});
afterAll(async () => {
  await dispose();
});

/** Påhittad transaktion (KK-13): ett köp på 1 240 kr. */
beforeEach(async () => {
  await db.prepare(`DELETE FROM transactions`).run();
  await db
    .prepare(
      `INSERT INTO transactions (id, account_id, fingerprint, status, last_seen_at, transaction_date, amount_minor, counterparty, counterparty_norm)
       VALUES ('t1', 'acc_1', 'fp', 'booked', '2026-10-31', '2026-10-31', -124000, 'CLAS OHLSON', 'CLAS OHLSON')`,
    )
    .run();
});

let seq = 0;
async function call(method: string, path: string, body?: unknown, init: { csrf?: boolean } = {}) {
  const context: RouteContext = {
    waitUntil: () => undefined,
    sync: { logger: captureLogs().logger, clock: fixedClock("2026-11-15T10:00:00.000Z"), newId: () => `s-${String(++seq)}`, providerFor: () => null },
    connectorFor: () => null,
  };
  const headers = new Headers({ "cf-access-jwt-assertion": await signToken(key), "content-type": "application/json" });
  if (init.csrf !== false && method !== "GET") {
    headers.set("origin", ORIGIN);
    headers.set("x-kronkoll", "1");
  }
  const request = new Request(`${ORIGIN}${path}`, { method, headers, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
  return handle(request, configuredEnv({ DB: db }), guardDeps, context);
}

const PARTS = [
  { category_id: "hushall-forbrukning", amount_minor: -90000 },
  { category_id: "fritid-hobby", amount_minor: -34000 },
];

describe("PUT /api/transactions/{id}/splits (KK-19)", () => {
  it("delar upp transaktionen när delarna summerar exakt till beloppet (KK-19-A)", async () => {
    const res = await call("PUT", "/api/transactions/t1/splits", { parts: PARTS });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ transaction_id: "t1", parts: 2 });
    const get = await call("GET", "/api/transactions/t1/splits");
    expect(await get.json()).toEqual({ transaction_id: "t1", amount_minor: -124000, parts: PARTS });
  });

  it("delar som inte summerar rätt ger 422 med hur mycket som återstår, och inget sparas (KK-19-B)", async () => {
    const res = await call("PUT", "/api/transactions/t1/splits", { parts: [PARTS[0], { ...PARTS[1], amount_minor: -30000 }] });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "split_sum_mismatch", expected_minor: -124000, actual_minor: -120000, remaining_minor: -4000 });
    expect(await (await call("GET", "/api/transactions/t1/splits")).json()).toMatchObject({ parts: [] });
  });

  it("en tom lista tar bort uppdelningen", async () => {
    await call("PUT", "/api/transactions/t1/splits", { parts: PARTS });
    const res = await call("PUT", "/api/transactions/t1/splits", { parts: [] });
    expect(await res.json()).toEqual({ transaction_id: "t1", parts: 0 });
    expect(await (await call("GET", "/api/transactions/t1/splits")).json()).toMatchObject({ parts: [] });
  });

  it.each([
    ["en enda del", { parts: [{ category_id: "hushall-forbrukning", amount_minor: -124000 }] }, "too_few_parts"],
    ["en del med fel tecken", { parts: [PARTS[0], { ...PARTS[1], amount_minor: 34000 }] }, "invalid_part"],
    ["en okänd kategori", { parts: [PARTS[0], { ...PARTS[1], category_id: "finns-inte" }] }, "unknown_category"],
    ["belopp som inte är heltal öre", { parts: [PARTS[0], { ...PARTS[1], amount_minor: -340.5 }] }, "invalid_request"],
    ["för många delar", { parts: Array.from({ length: 11 }, () => PARTS[0]) }, "invalid_request"],
    ["inga delar alls", {}, "invalid_request"],
    ["inte JSON", "{", "invalid_request"],
  ])("%s ger 400 (%s)", async (_, body, error) => {
    const res = await call("PUT", "/api/transactions/t1/splits", body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error });
  });

  it("en transaktion som inte finns ger 404", async () => {
    expect((await call("PUT", "/api/transactions/saknas/splits", { parts: PARTS })).status).toBe(404);
    expect((await call("GET", "/api/transactions/saknas/splits")).status).toBe(404);
  });

  it("kräver CSRF-skydd och tillåter bara GET och PUT", async () => {
    expect((await call("PUT", "/api/transactions/t1/splits", { parts: PARTS }, { csrf: false })).status).toBe(403);
    const res = await call("POST", "/api/transactions/t1/splits", { parts: PARTS });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, PUT");
  });
});
