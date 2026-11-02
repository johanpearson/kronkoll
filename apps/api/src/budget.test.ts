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
  key = await createTestKey("budget-key");
  const { fetchImpl } = jwksFetch(key);
  guardDeps = {
    verifierFor: () => cachedVerifier({ issuer: ISSUER, audience: AUD, allowedEmails: [INVITED], appOrigin: ORIGIN }, fetchImpl),
    logger: captureLogs().logger,
  };
  await connectionRepository(db, keys).create({ id: "c1", provider: "enablebanking", aspspName: "Skandia" });
  await accountRepository(db, keys).upsertFromBank({ connectionId: "c1", providerUid: "u1", iban: null, name: "Privatkonto", type: "checking", balanceMinor: 0 }, () => "acc_1");
  // Påhittade transaktioner (KK-13) i november.
  const rows: [string, string, number, string | null, number][] = [
    ["ica", "2026-11-03", -2000, "mat-livsmedel", 0],
    ["okat", "2026-11-04", -3000, null, 0],
    ["intern", "2026-11-10", -500000, null, 1],
    ["delad", "2026-11-20", -124000, null, 0],
    ["lon", "2026-11-25", 2500000, "inkomst-lon", 0],
  ];
  await db.batch(
    rows.map(([id, date, amount, category, internal]) =>
      db
        .prepare(
          `INSERT INTO transactions (id, account_id, fingerprint, status, last_seen_at, transaction_date, booking_date, amount_minor, category_id, category_source, is_internal_transfer)
           VALUES (?, 'acc_1', 'fp', 'booked', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, date, date, date, amount, category, category === null ? "none" : "template", internal),
    ),
  );
  await db.prepare(`INSERT INTO transaction_splits (id, transaction_id, category_id, amount_minor) VALUES ('s1', 'delad', 'hushall-forbrukning', -90000), ('s2', 'delad', 'fritid-hobby', -34000)`).run();
});
afterAll(async () => {
  await dispose();
});
beforeEach(async () => {
  await db.prepare(`DELETE FROM budget_lines`).run();
  await settingsRepository(db).setBudgetPeriodStartDay(1);
});

async function call(method: string, path: string, body?: unknown, env: Partial<Env> = {}) {
  const context: RouteContext = {
    waitUntil: () => undefined,
    sync: { logger: captureLogs().logger, clock: fixedClock("2026-11-15T10:00:00.000Z"), newId: () => "x", providerFor: () => null },
    connectorFor: () => null,
  };
  const headers = new Headers({ "cf-access-jwt-assertion": await signToken(key), "content-type": "application/json" });
  if (method !== "GET") {
    headers.set("origin", ORIGIN);
    headers.set("x-kronkoll", "1");
  }
  const init = { method, headers, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) };
  return handle(new Request(`${ORIGIN}${path}`, init), configuredEnv({ DB: db, ...env }), guardDeps, context);
}

const LINES = [
  { category_id: "mat", amount_minor: 1000 },
  { category_id: "hushall", amount_minor: 100000 },
];

describe("GET /api/budgets/{period} (KK-20, KK-34)", () => {
  it("ger utfall mot budget per kategori, utgifter utan budget och vad interna överföringar uteslöt", async () => {
    await call("PUT", "/api/budgets/2026-11", { lines: LINES });
    const res = await call("GET", "/api/budgets/2026-11");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      period: { key: "2026-11", start: "2026-11-01", end: "2026-11-30" },
      lines: [
        { category_id: "hushall", budget_minor: 100000, actual_minor: 90000, remaining_minor: 10000, percent: 90, over: false },
        { category_id: "mat", budget_minor: 1000, actual_minor: 2000, remaining_minor: -1000, percent: 200, over: true },
      ],
      unbudgeted_minor: 37000,
      total_budget_minor: 101000,
      total_actual_minor: 129000,
      excluded_internal_minor: 500000,
      spending: [
        { category_id: null, actual_minor: 3000 },
        { category_id: "fritid-hobby", actual_minor: 34000 },
        { category_id: "hushall-forbrukning", actual_minor: 90000 },
        { category_id: "mat-livsmedel", actual_minor: 2000 },
      ],
    });
  });

  it("en period utan budget ger bara utgifterna", async () => {
    const body = await (await call("GET", "/api/budgets/2026-11")).json<{ lines: unknown[]; unbudgeted_minor: number }>();
    expect(body.lines).toEqual([]);
    expect(body.unbudgeted_minor).toBe(129000);
  });

  it("\"current\" ger den pågående perioden enligt startdagen (KK-34)", async () => {
    await settingsRepository(db).setBudgetPeriodStartDay(25);
    const body = await (await call("GET", "/api/budgets/current")).json<{ period: unknown }>();
    expect(body.period).toEqual({ key: "2026-11", start: "2026-10-23", end: "2026-11-24" });
  });

  it.each(["/api/budgets/2026-13", "/api/budgets/november"])("%s ger 400", async (path) => {
    const res = await call("GET", path);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
  });

  it("svarar 503 utan detaljer när databasen inte går att läsa", async () => {
    const broken = { prepare: () => { throw new Error("D1 nere"); } } as unknown as D1Database;
    const res = await call("GET", "/api/budgets/2026-11", undefined, { DB: broken });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
  });
});

describe("PUT /api/budgets/{period} (KK-20)", () => {
  it("ersätter periodens budget och säger hur många rader den har", async () => {
    await call("PUT", "/api/budgets/2026-11", { lines: LINES });
    const res = await call("PUT", "/api/budgets/2026-11", { lines: [LINES[0]], source: "copy_previous" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ period: "2026-11", lines: 1 });
    expect((await (await call("GET", "/api/budgets/2026-11")).json<{ lines: { category_id: string }[] }>()).lines.map((l) => l.category_id)).toEqual(["mat"]);
  });

  it.each([
    ["en okänd kategori", { lines: [{ category_id: "finns-inte", amount_minor: 100 }] }, "unknown_category"],
    ["en inkomstkategori", { lines: [{ category_id: "inkomst-lon", amount_minor: 100 }] }, "unknown_category"],
    ["ett negativt belopp", { lines: [{ category_id: "mat", amount_minor: -1 }] }, "invalid_request"],
    ["belopp som inte är heltal öre", { lines: [{ category_id: "mat", amount_minor: 10.5 }] }, "invalid_request"],
    ["samma kategori två gånger", { lines: [LINES[0], LINES[0]] }, "invalid_request"],
    ["en okänd källa", { lines: LINES, source: "gissning" }, "invalid_request"],
    ["inga rader", {}, "invalid_request"],
    ["inte JSON", "{", "invalid_request"],
  ])("%s ger 400 och ändrar ingenting", async (_, body, error) => {
    await call("PUT", "/api/budgets/2026-11", { lines: LINES });
    const res = await call("PUT", "/api/budgets/2026-11", body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error });
    expect((await (await call("GET", "/api/budgets/2026-11")).json<{ lines: unknown[] }>()).lines).toHaveLength(2);
  });

  it("andra metoder ger 405, och ändringar kräver CSRF-skydd", async () => {
    const res = await call("DELETE", "/api/budgets/2026-11");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, PUT");
  });
});
