import type { D1Database } from "@cloudflare/workers-types";
import { accountRepository, connectionRepository, deriveKeys, settingsRepository } from "@kronkoll/adapter-d1";
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
  key = await createTestKey("transactions-key");
  const { fetchImpl } = jwksFetch(key);
  guardDeps = {
    verifierFor: () => cachedVerifier({ issuer: ISSUER, audience: AUD, allowedEmails: [INVITED], appOrigin: ORIGIN }, fetchImpl),
    logger: captureLogs().logger,
  };
  await connectionRepository(db, keys).create({ id: "c1", provider: "enablebanking", aspspName: "Skandia" });
  await accountRepository(db, keys).upsertFromBank({ connectionId: "c1", providerUid: "u1", iban: null, name: "Privatkonto", type: "checking", balanceMinor: 0 }, () => "acc_1");
  // Påhittade transaktioner (KK-13), runt periodgränserna i oktober och november.
  const rows: [string, string, number, string][] = [
    ["t1", "2026-10-24", -1000, "FÖRE LÖNEDAGEN"],
    ["t2", "2026-10-26", -2000, "<b>ICA</b>"],
    ["t3", "2026-11-03", -3000, "SL"],
    ["t4", "2026-11-24", -4000, "SISTA I PERIODEN"],
    ["t5", "2026-11-25", -5000, "EFTER LÖNEDAGEN"],
  ];
  await db.batch(
    rows.map(([id, date, amount, counterparty]) =>
      db
        .prepare(
          `INSERT INTO transactions (id, account_id, fingerprint, status, last_seen_at, transaction_date, booking_date, amount_minor, counterparty, counterparty_norm)
           VALUES (?, 'acc_1', 'fp', 'booked', ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, date, date, date, amount, counterparty, counterparty),
    ),
  );
});
afterAll(async () => {
  await dispose();
});
beforeEach(async () => {
  await settingsRepository(db).setBudgetPeriodStartDay(1);
});

async function get(query = "", init: { method?: string; at?: string; env?: Partial<Env> } = {}) {
  const context: RouteContext = {
    waitUntil: () => undefined,
    sync: { logger: captureLogs().logger, clock: fixedClock(init.at ?? "2026-11-15T10:00:00.000Z"), newId: () => "x", providerFor: () => null },
    connectorFor: () => null,
  };
  const headers = new Headers({ "cf-access-jwt-assertion": await signToken(key) });
  const method = init.method ?? "GET";
  if (method !== "GET") {
    headers.set("origin", ORIGIN);
    headers.set("x-kronkoll", "1");
  }
  return handle(new Request(`${ORIGIN}/api/transactions${query}`, { method, headers }), configuredEnv({ DB: db, ...init.env }), guardDeps, context);
}

type Body = { period: { key: string; start: string; end: string }; items: Record<string, unknown>[]; next_cursor: string | null };
const body = async (response: Response) => response.json<Body>();
const ids = async (response: Response) => (await body(response)).items.map((i) => i.id);

describe("GET /api/transactions (#32, KK-9, KK-18, KK-34)", () => {
  it("utan period ges den pågående budgetperioden enligt svensk tid", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const { period } = await body(res);
    expect(period).toEqual({ key: "2026-11", start: "2026-11-01", end: "2026-11-30" });
    expect(await ids(await get())).toEqual(["t5", "t4", "t3"]);
  });

  it("följer budgetperiodens startdag, till exempel lönedagen den 25:e (KK-34)", async () => {
    await settingsRepository(db).setBudgetPeriodStartDay(25);
    const res = await get("?period=2026-11");
    const { period } = await body(res.clone());
    expect(period).toEqual({ key: "2026-11", start: "2026-10-23", end: "2026-11-24" });
    expect(await ids(res)).toEqual(["t4", "t3", "t2", "t1"]);
  });

  it("ger fälten i snake_case, med bankens text oförändrad", async () => {
    const { items } = await body(await get("?period=2026-10&limit=1&q=ica"));
    expect(items).toEqual([
      {
        id: "t2",
        account_id: "acc_1",
        status: "booked",
        transaction_date: "2026-10-26",
        booking_date: "2026-10-26",
        amount_minor: -2000,
        counterparty: "<b>ICA</b>",
        description: "",
        category_id: null,
        category_source: "none",
        is_internal_transfer: false,
        manual_transfer: null,
        split: false,
      },
    ]);
  });

  it("bläddrar med limit och next_cursor", async () => {
    const first = await body(await get("?period=2026-11&limit=2"));
    expect(first.items.map((i) => i.id)).toEqual(["t5", "t4"]);
    expect(first.next_cursor).not.toBeNull();
    const second = await body(await get(`?period=2026-11&limit=2&cursor=${encodeURIComponent(first.next_cursor ?? "")}`));
    expect(second.items.map((i) => i.id)).toEqual(["t3"]);
    expect(second.next_cursor).toBeNull();
  });

  it("filtrerar på okategoriserade", async () => {
    expect(await ids(await get("?period=2026-11&uncategorized=true"))).toEqual(["t5", "t4", "t3"]);
  });

  it.each([
    ["en period som inte finns", "?period=2026-13"],
    ["fel format på perioden", "?period=november"],
    ["en ogiltig cursor", "?cursor=inte-en-cursor"],
    ["limit 0", "?limit=0"],
    ["limit över 200", "?limit=201"],
    ["limit som inte är ett tal", "?limit=många"],
    ["uncategorized som inte är true eller false", "?uncategorized=ja"],
    ["för lång sökning", `?q=${"x".repeat(101)}`],
  ])("%s ger 400", async (_, query) => {
    const res = await get(query);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
  });

  it("svarar 503 utan detaljer när databasen inte går att läsa", async () => {
    const broken = { prepare: () => { throw new Error("D1 nere"); } } as unknown as D1Database;
    const res = await get("", { env: { DB: broken } });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
  });

  it("andra metoder ger 405", async () => {
    const res = await get("", { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });
});
