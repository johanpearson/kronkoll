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
  key = await createTestKey("hide-key");
  const { fetchImpl } = jwksFetch(key);
  guardDeps = {
    verifierFor: () => cachedVerifier({ issuer: ISSUER, audience: AUD, allowedEmails: [INVITED], appOrigin: ORIGIN }, fetchImpl),
    logger: captureLogs().logger,
  };
  await connectionRepository(db, keys).create({ id: "c1", provider: "enablebanking", aspspName: "Skandia" });
  const accounts = accountRepository(db, keys);
  await accounts.upsertFromBank({ connectionId: "c1", providerUid: "u1", iban: null, name: "Budget", type: "checking", balanceMinor: 0 }, () => "acc_budget");
  await accounts.upsertFromBank({ connectionId: "c1", providerUid: "u2", iban: null, name: "Spar", type: "savings", balanceMinor: 0 }, () => "acc_spar");
});
afterAll(async () => {
  await dispose();
});

/** Påhittade transaktioner (KK-13): en lön, ett par mellan egna konton och två köp. */
beforeEach(async () => {
  await db.prepare(`DELETE FROM transactions`).run();
  const rows: [string, string, number, string][] = [
    ["lon", "acc_budget", 3_300_000, "ARBETSGIVAREN"],
    ["ut", "acc_budget", -500_000, "SPARKONTO"],
    ["in", "acc_spar", 500_000, "BUDGETKONTO"],
    ["kop1", "acc_budget", -4_500, "ESPRESSO HOUSE"],
    ["kop2", "acc_budget", -9_000, "KAFFEBARON"],
  ];
  await db.batch(
    rows.map(([id, account, amount, norm]) =>
      db
        .prepare(
          `INSERT INTO transactions (id, account_id, fingerprint, status, last_seen_at, transaction_date, amount_minor, counterparty, counterparty_norm, income_type)
           VALUES (?, ?, 'fp', 'booked', '2026-11-02', '2026-11-02', ?, ?, ?, ?)`,
        )
        .bind(id, account, amount, norm, norm, id === "lon" ? "salary" : null),
    ),
  );
  await db.batch([
    db.prepare(`UPDATE transactions SET is_internal_transfer = 1, transfer_pair_id = 'in' WHERE id = 'ut'`),
    db.prepare(`UPDATE transactions SET is_internal_transfer = 1, transfer_pair_id = 'ut' WHERE id = 'in'`),
  ]);
});

async function call(method: string, path: string, body?: unknown, init: { csrf?: boolean; env?: Partial<Env> } = {}) {
  const context: RouteContext = {
    waitUntil: () => undefined,
    sync: { logger: captureLogs().logger, clock: fixedClock("2026-11-15T10:00:00.000Z"), newId: () => "x", providerFor: () => null },
    connectorFor: () => null,
  };
  const headers = new Headers({ "cf-access-jwt-assertion": await signToken(key), "content-type": "application/json" });
  if (method !== "GET" && init.csrf !== false) {
    headers.set("origin", ORIGIN);
    headers.set("x-kronkoll", "1");
  }
  const request = new Request(`${ORIGIN}${path}`, { method, headers, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
  return handle(request, configuredEnv({ DB: db, ...init.env }), guardDeps, context);
}

const hide = (ids: string[], hidden: boolean) => call("POST", "/api/transactions/hide", { ids, hidden });
const listed = async (query = "") => (await (await call("GET", `/api/transactions?period=2026-11${query}`)).json<{ items: { id: string; hidden: boolean }[] }>()).items.map((t) => t.id).sort();
const flags = async () => (await db.prepare(`SELECT id, is_internal_transfer AS i, manual_transfer AS m, hidden AS h FROM transactions ORDER BY id`).all<{ id: string; i: number; m: number | null; h: number }>()).results;
const broken = { prepare: () => { throw new Error("D1 nere"); } } as unknown as D1Database;

describe("POST /api/transactions/hide (KK-49)", () => {
  it("döljer flera på en gång: de försvinner ur listan och räknas inte, och visa igen ångrar det (KK-49-A, KK-49-B)", async () => {
    expect(await listed()).toEqual(["in", "kop1", "kop2", "lon", "ut"]);
    expect((await (await call("GET", "/api/budgets/2026-11")).json<{ total_actual_minor: number }>()).total_actual_minor).toBe(13_500);
    const res = await hide(["kop1", "lon"], true);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: 2, hidden: true });
    expect(await listed()).toEqual(["in", "kop2", "ut"]);
    expect(await listed("&hidden=true")).toEqual(["kop1", "lon"]);
    // De räknas inte i inkomst eller i budgetens utfall, och inga andra rader ändras.
    expect((await (await call("GET", "/api/income/2026-11")).json<{ items: unknown[] }>()).items).toEqual([]);
    const budget = await (await call("GET", "/api/budgets/2026-11")).json<{ total_actual_minor: number; uncategorized_minor: number }>();
    expect(budget.uncategorized_minor).toBe(9_000);
    expect(budget.total_actual_minor).toBe(9_000);
    expect((await flags()).filter((f) => f.i === 1).map((f) => f.id)).toEqual(["in", "kop1", "lon", "ut"]);

    const back = await hide(["kop1", "lon"], false);
    expect(await back.json()).toEqual({ updated: 2, hidden: false });
    expect(await listed()).toEqual(["in", "kop1", "kop2", "lon", "ut"]);
    expect((await call("GET", "/api/income/2026-11").then((r) => r.json<{ items: { id: string }[] }>())).items.map((i) => i.id)).toEqual(["lon"]);
    expect((await flags()).filter((f) => f.i === 1).map((f) => f.id)).toEqual(["in", "ut"]);
  });

  it("ett eget val (Räknas inte) och ett par rörs inte, utan gäller igen när transaktionerna visas (KK-49-C)", async () => {
    await call("PUT", "/api/transactions/kop2/transfer", { internal: true });
    await hide(["kop2", "ut"], true);
    expect((await flags()).find((f) => f.id === "kop2")).toMatchObject({ i: 1, m: 1, h: 1 });
    // Det dolda halva paret pekar inte längre på sin motpost, och motposten räknas som en vanlig transaktion.
    expect((await flags()).find((f) => f.id === "in")).toMatchObject({ i: 0 });
    await hide(["kop2", "ut"], false);
    expect((await flags()).find((f) => f.id === "kop2")).toMatchObject({ i: 1, m: 1, h: 0 });
    expect((await flags()).filter((f) => f.id === "ut" || f.id === "in")).toEqual([
      { id: "in", i: 1, m: null, h: 0 },
      { id: "ut", i: 1, m: null, h: 0 },
    ]);
  });

  it("okända id hoppas över och ger 0 när inget fanns", async () => {
    expect(await (await hide(["finns-inte"], true)).json()).toEqual({ updated: 0, hidden: true });
    expect(await (await hide(["kop1", "finns-inte"], true)).json()).toEqual({ updated: 1, hidden: true });
  });

  it.each([
    ["inga id", { ids: [], hidden: true }],
    ["id som inte är en lista", { ids: "kop1", hidden: true }],
    ["ett id som inte är text", { ids: [1], hidden: true }],
    ["ett tomt id", { ids: [""], hidden: true }],
    ["ett för långt id", { ids: ["x".repeat(65)], hidden: true }],
    ["samma id två gånger", { ids: ["kop1", "kop1"], hidden: true }],
    ["för många id", { ids: Array.from({ length: 101 }, (_, i) => `t${String(i)}`), hidden: true }],
    ["hidden som inte är sant eller falskt", { ids: ["kop1"], hidden: "ja" }],
    ["saknat hidden", { ids: ["kop1"] }],
    ["kroppen är inte ett objekt", "[]"],
    ["kroppen är inte JSON", "{"],
  ])("%s ger 400 och ändrar ingenting", async (_, body) => {
    const res = await call("POST", "/api/transactions/hide", body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
    expect((await flags()).every((f) => f.h === 0)).toBe(true);
  });

  it("tar emot upp till 100 id, kräver CSRF-skydd och POST, och svarar 503 utan detaljer när databasen inte går att nå", async () => {
    expect((await hide(Array.from({ length: 100 }, (_, i) => `t${String(i)}`), true)).status).toBe(200);
    expect((await call("POST", "/api/transactions/hide", { ids: ["kop1"], hidden: true }, { csrf: false })).status).toBe(403);
    const wrong = await call("GET", "/api/transactions/hide");
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toBe("POST");
    const down = await call("POST", "/api/transactions/hide", { ids: ["kop1"], hidden: true }, { env: { DB: broken } });
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ error: "unavailable" });
  });

  it("listan kräver true eller false för hidden", async () => {
    expect((await call("GET", "/api/transactions?hidden=ja")).status).toBe(400);
    expect((await call("GET", "/api/transactions?hidden=false")).status).toBe(200);
  });
});
