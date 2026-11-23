import type { D1Database } from "@cloudflare/workers-types";
import { accountRepository, connectionRepository, deriveKeys } from "@kronkoll/adapter-d1";
import { migratedDb, randomSecret } from "@kronkoll/adapter-d1/test-support";
import { fixedClock } from "@kronkoll/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cachedVerifier, type GuardDeps } from "./access.ts";
import { handle, type Env, type RouteContext } from "./index.ts";
import { AUD, INVITED, ISSUER, ORIGIN, captureLogs, configuredEnv, createTestKey, jwksFetch, signToken, type TestKey } from "./test-support.ts";

let db: D1Database;
let dispose: () => Promise<void>;
let key: TestKey;
let guardDeps: GuardDeps;

beforeAll(async () => {
  ({ db, dispose } = await migratedDb());
  const keys = await deriveKeys(randomSecret());
  key = await createTestKey("accounts-key");
  const { fetchImpl } = jwksFetch(key);
  guardDeps = {
    verifierFor: () => cachedVerifier({ issuer: ISSUER, audience: AUD, allowedEmails: [INVITED], appOrigin: ORIGIN }, fetchImpl),
    logger: captureLogs().logger,
  };
  // Påhittade konton (KK-13).
  await connectionRepository(db, keys).create({ id: "c1", provider: "enablebanking", aspspName: "Skandia" });
  const accounts = accountRepository(db, keys);
  await accounts.upsertFromBank({ connectionId: "c1", providerUid: "u1", iban: "SE45 5000 0000 0583 9825 4821", name: "Privatkonto", type: "checking", balanceMinor: 0 }, () => "acc_1");
  await accounts.upsertFromBank({ connectionId: "c1", providerUid: "u2", iban: null, name: "Sparkonto", type: "savings", balanceMinor: 0 }, () => "acc_2");
});
afterAll(async () => {
  await dispose();
});
beforeEach(async () => {
  await db.prepare(`UPDATE accounts SET nickname = NULL, included = 1`).run();
  await db.prepare(`DELETE FROM transactions`).run();
});

async function call(method: string, path: string, body?: unknown, env: Partial<Env> = {}, csrf = true) {
  const context: RouteContext = {
    waitUntil: () => undefined,
    sync: { logger: captureLogs().logger, clock: fixedClock("2026-11-15T10:00:00.000Z"), newId: () => "x", providerFor: () => null },
    connectorFor: () => null,
  };
  const headers = new Headers({ "cf-access-jwt-assertion": await signToken(key), "content-type": "application/json" });
  if (method !== "GET" && csrf) {
    headers.set("origin", ORIGIN);
    headers.set("x-kronkoll", "1");
  }
  const init = { method, headers, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) };
  return handle(new Request(`${ORIGIN}${path}`, init), configuredEnv({ DB: db, ...env }), guardDeps, context);
}

const items = async () => (await (await call("GET", "/api/accounts")).json<{ items: Record<string, unknown>[] }>()).items;

describe("GET /api/accounts (KK-37)", () => {
  it("listar kontona med bankens maskerade namn när inget eget namn finns", async () => {
    const res = await call("GET", "/api/accounts");
    expect(res.status).toBe(200);
    expect(await items()).toEqual([
      { id: "acc_1", name: "Privatkonto ••4821", nickname: null, bank_name: "Privatkonto ••4821", bank: "Skandia", type: "checking", counted: true },
      { id: "acc_2", name: "Sparkonto", nickname: null, bank_name: "Sparkonto", bank: "Skandia", type: "savings", counted: true },
    ]);
  });

  it("svarar 503 utan detaljer när databasen inte går att läsa", async () => {
    const broken = { prepare: () => { throw new Error("D1 nere"); } } as unknown as D1Database;
    const res = await call("GET", "/api/accounts", undefined, { DB: broken });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
  });

  it("andra metoder ger 405", async () => {
    const res = await call("POST", "/api/accounts", {});
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });
});

const insertTx = (id: string, account: string, date: string, amount: number) =>
  db
    .prepare(`INSERT INTO transactions (id, account_id, fingerprint, status, last_seen_at, transaction_date, amount_minor) VALUES (?, ?, ?, 'booked', '2026-11-15', ?, ?)`)
    .bind(id, account, id, date, amount)
    .run();
const isInternal = async (id: string) => (await db.prepare(`SELECT is_internal_transfer AS i FROM transactions WHERE id = ?`).bind(id).first<{ i: number }>())?.i === 1;

describe("PATCH /api/accounts/{id} counted (KK-41)", () => {
  it("sparar att kontot inte räknas med och svarar med det, utan att ändra namnet", async () => {
    await call("PATCH", "/api/accounts/acc_2", { nickname: "Privat sparande" });
    const res = await call("PATCH", "/api/accounts/acc_2", { counted: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "acc_2", name: "Privat sparande", nickname: "Privat sparande", counted: false });
    expect((await items())[1]).toMatchObject({ nickname: "Privat sparande", counted: false });
  });

  it("KK-41-B: en överföring dit räknas som utgift, och den blir intern igen när kontot räknas med", async () => {
    await insertTx("ut", "acc_1", "2026-11-10", -200000);
    await insertTx("in", "acc_2", "2026-11-10", 200000);
    await call("PATCH", "/api/accounts/acc_2", { counted: true });
    expect([await isInternal("ut"), await isInternal("in")]).toEqual([true, true]);
    await call("PATCH", "/api/accounts/acc_2", { counted: false });
    expect([await isInternal("ut"), await isInternal("in")]).toEqual([false, true]);
    await call("PATCH", "/api/accounts/acc_2", { counted: true });
    expect([await isInternal("ut"), await isInternal("in")]).toEqual([true, true]);
  });

  it("ett okänt konto ger 404 och räknar inte om", async () => {
    expect((await call("PATCH", "/api/accounts/finns-inte", { counted: false })).status).toBe(404);
  });
});

describe("PATCH /api/accounts/{id} (KK-37-A)", () => {
  it("sätter ett trimmat eget namn, som sedan är kontots namn", async () => {
    const res = await call("PATCH", "/api/accounts/acc_1", { nickname: "  Privat kort " });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "acc_1", name: "Privat kort", nickname: "Privat kort", counted: true });
    expect((await items())[0]).toMatchObject({ name: "Privat kort", bank_name: "Privatkonto ••4821" });
  });

  it.each([null, "", "   "])("%j tar bort det egna namnet, och bankens namn visas igen", async (nickname) => {
    await call("PATCH", "/api/accounts/acc_1", { nickname: "Privat kort" });
    const res = await call("PATCH", "/api/accounts/acc_1", { nickname });
    expect(await res.json()).toEqual({ id: "acc_1", name: "Privatkonto ••4821", nickname: null, counted: true });
  });

  it("sparar HTML-liknande text som den är; appen renderar den som text (KK-37-C)", async () => {
    const res = await call("PATCH", "/api/accounts/acc_2", { nickname: "<b>Buffert</b>" });
    expect(await res.json()).toMatchObject({ nickname: "<b>Buffert</b>" });
  });

  it("tillåter 40 tecken, också med å, ä och ö", async () => {
    const res = await call("PATCH", "/api/accounts/acc_2", { nickname: "Ö".repeat(40) });
    expect(res.status).toBe(200);
  });

  it.each([
    ["ett för långt namn", { nickname: "x".repeat(41) }],
    ["styrtecken", { nickname: "Buffert\u0000" }],
    ["en radbrytning", { nickname: "Buf\nfert" }],
    ["ett tal", { nickname: 7 }],
    ["inget namn och inget val", {}],
    ["ett räknas med som inte är sant eller falskt", { counted: "ja" }],
    ["ett räknas med som är null", { counted: null }],
    ["inte JSON", "{"],
  ])("%s ger 400 och ändrar ingenting", async (_, body) => {
    const res = await call("PATCH", "/api/accounts/acc_2", body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
    expect((await items())[1]).toMatchObject({ nickname: null });
  });

  it("ett okänt konto ger 404", async () => {
    const res = await call("PATCH", "/api/accounts/finns-inte", { nickname: "Buffert" });
    expect(res.status).toBe(404);
  });

  it("kräver CSRF-skydd, och andra metoder ger 405", async () => {
    expect((await call("PATCH", "/api/accounts/acc_1", { nickname: "X" }, {}, false)).status).toBe(403);
    const res = await call("DELETE", "/api/accounts/acc_1");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("PATCH");
  });

  it("svarar 503 utan detaljer när databasen inte går att skriva", async () => {
    const broken = { prepare: () => { throw new Error("D1 nere"); } } as unknown as D1Database;
    const res = await call("PATCH", "/api/accounts/acc_1", { nickname: "X" }, { DB: broken });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
  });
});
