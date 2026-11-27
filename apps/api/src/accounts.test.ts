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
  await db.prepare(`UPDATE accounts SET nickname = NULL, role = 'spending'`).run();
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
      { id: "acc_1", name: "Privatkonto ••4821", nickname: null, bank_name: "Privatkonto ••4821", bank: "Skandia", type: "checking", role: "spending" },
      { id: "acc_2", name: "Sparkonto", nickname: null, bank_name: "Sparkonto", bank: "Skandia", type: "savings", role: "spending" },
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

describe("PATCH /api/accounts/{id} role: Uteslutet och Buffert (KK-41-B, KK-52)", () => {
  it("sparar Uteslutet och svarar med rollen, utan att ändra namnet", async () => {
    await call("PATCH", "/api/accounts/acc_2", { nickname: "Privat sparande" });
    const res = await call("PATCH", "/api/accounts/acc_2", { role: "excluded" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "acc_2", name: "Privat sparande", nickname: "Privat sparande", role: "excluded" });
    expect((await items())[1]).toMatchObject({ nickname: "Privat sparande", role: "excluded" });
  });

  it("KK-41-B: en överföring till ett uteslutet konto räknas som utgift, och den blir intern igen med Inkomst/Utgift", async () => {
    await insertTx("ut", "acc_1", "2026-11-10", -200000);
    await insertTx("in", "acc_2", "2026-11-10", 200000);
    await call("PATCH", "/api/accounts/acc_2", { role: "spending" });
    expect([await isInternal("ut"), await isInternal("in")]).toEqual([true, true]);
    await call("PATCH", "/api/accounts/acc_2", { role: "excluded" });
    expect([await isInternal("ut"), await isInternal("in")]).toEqual([false, true]);
    await call("PATCH", "/api/accounts/acc_2", { role: "spending" });
    expect([await isInternal("ut"), await isInternal("in")]).toEqual([true, true]);
  });

  it("de gamla fälten counted och saving finns inte längre och ger 400 (KK-53-B)", async () => {
    expect((await call("PATCH", "/api/accounts/acc_2", { counted: false })).status).toBe(400);
    expect((await call("PATCH", "/api/accounts/acc_2", { saving: true })).status).toBe(400);
    expect((await call("PATCH", "/api/accounts/acc_2", { role: "sparkonto" })).status).toBe(400);
    expect((await items())[1]).toMatchObject({ role: "spending" });
  });
});

describe("PATCH /api/accounts/{id} role (KK-53, V-i-roles)", () => {
  it("sätter rollen, svarar med den och räknar om alla perioder", async () => {
    await insertTx("ut", "acc_1", "2026-10-10", -200000);
    await insertTx("in", "acc_2", "2026-10-10", 200000);
    await insertTx("uttag-ut", "acc_2", "2026-11-12", -50000);
    await insertTx("uttag-in", "acc_1", "2026-11-12", 50000);
    const res = await call("PATCH", "/api/accounts/acc_2", { role: "buffer" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "acc_2", name: "Sparkonto", nickname: null, role: "buffer" });
    expect((await items())[1]).toMatchObject({ role: "buffer" });
    // Sparande på Inkomst/Utgift, buffertens rad räknas inte, och uttaget från bufferten är inte en inkomst (KK-55).
    expect([await isInternal("ut"), await isInternal("in"), await isInternal("uttag-in"), await isInternal("uttag-ut")]).toEqual([false, true, true, true]);
    const kinds = await db.prepare(`SELECT id, saving_kind AS kind FROM transactions ORDER BY id`).all<{ id: string; kind: string | null }>();
    expect(kinds.results).toEqual([
      { id: "in", kind: null },
      { id: "ut", kind: "saving" },
      { id: "uttag-in", kind: "saving_withdrawal" },
      { id: "uttag-ut", kind: null },
    ]);
    await call("PATCH", "/api/accounts/acc_2", { role: "excluded" });
    expect((await items())[1]).toMatchObject({ role: "excluded" });
    expect([await isInternal("ut"), await isInternal("uttag-in")]).toEqual([false, false]);
    await call("PATCH", "/api/accounts/acc_2", { role: "spending" });
    expect([await isInternal("ut"), await isInternal("uttag-in")]).toEqual([true, true]);
    expect(await db.prepare(`SELECT count(*) AS n FROM transactions WHERE saving_kind IS NOT NULL`).first("n")).toBe(0);
  });

  it("sparande till bufferten får kategorin Sparande, men ett eget val eller en kategori som redan finns rörs inte (KK-53)", async () => {
    await insertTx("spar", "acc_1", "2026-11-03", -200000);
    await insertTx("spar-in", "acc_2", "2026-11-03", 200000);
    await insertTx("eget", "acc_1", "2026-11-20", -10000);
    await insertTx("eget-in", "acc_2", "2026-11-20", 10000);
    await db.prepare(`UPDATE transactions SET category_id = 'mat-livsmedel', category_source = 'manual' WHERE id = 'eget'`).run();
    await call("PATCH", "/api/accounts/acc_2", { role: "buffer" });
    const category = async (id: string) => db.prepare(`SELECT category_id AS c, category_source AS s FROM transactions WHERE id = ?`).bind(id).first();
    expect(await category("spar")).toEqual({ c: "sparande-overforingar-sparande", s: "template" });
    expect(await category("eget")).toEqual({ c: "mat-livsmedel", s: "manual" });
    expect(await category("spar-in")).toEqual({ c: null, s: "none" });
  });

  it("ett okänt konto ger 404", async () => {
    expect((await call("PATCH", "/api/accounts/finns-inte", { role: "buffer" })).status).toBe(404);
  });
});

describe("PATCH /api/accounts/{id} (KK-37-A)", () => {
  it("sätter ett trimmat eget namn, som sedan är kontots namn", async () => {
    const res = await call("PATCH", "/api/accounts/acc_1", { nickname: "  Privat kort " });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "acc_1", name: "Privat kort", nickname: "Privat kort", role: "spending" });
    expect((await items())[0]).toMatchObject({ name: "Privat kort", bank_name: "Privatkonto ••4821" });
  });

  it.each([null, "", "   "])("%j tar bort det egna namnet, och bankens namn visas igen", async (nickname) => {
    await call("PATCH", "/api/accounts/acc_1", { nickname: "Privat kort" });
    const res = await call("PATCH", "/api/accounts/acc_1", { nickname });
    expect(await res.json()).toEqual({ id: "acc_1", name: "Privatkonto ••4821", nickname: null, role: "spending" });
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
    ["bara ett gammalt val", { counted: "ja" }],
    ["en okänd roll", { role: "savings" }],
    ["en roll som inte är text", { role: null }],
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
