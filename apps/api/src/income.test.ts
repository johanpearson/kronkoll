import type { D1Database } from "@cloudflare/workers-types";
import { migratedDb } from "@kronkoll/adapter-d1/test-support";
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
  key = await createTestKey("income-key");
  const { fetchImpl } = jwksFetch(key);
  guardDeps = {
    verifierFor: () => cachedVerifier({ issuer: ISSUER, audience: AUD, allowedEmails: [INVITED], appOrigin: ORIGIN }, fetchImpl),
    logger: captureLogs().logger,
  };
});
afterAll(async () => {
  await dispose();
});

/** Påhittade inbetalningar (KK-13): lön i oktober och november, föräldrapenning i oktober, en Swish i december 2025. */
beforeEach(async () => {
  const tx = (id: string, date: string, amount: number, type: string | null) =>
    db
      .prepare(
        `INSERT INTO transactions (id, account_id, fingerprint, status, last_seen_at, transaction_date, amount_minor, income_type, income_source)
         VALUES (?, 'a1', 'fp', 'booked', ?, ?, ?, ?, 'template')`,
      )
      .bind(id, date, date, amount, type);
  await db.batch([
    db.prepare(`DELETE FROM bank_connections`),
    db.prepare(`INSERT INTO bank_connections (id, provider, status) VALUES ('c1', 'enablebanking', 'active')`),
    db.prepare(`INSERT INTO accounts (id, connection_id, display_name, type) VALUES ('a1', 'c1', 'Privatkonto', 'checking')`),
    tx("lon-okt", "2026-10-24", 3_300_000, "salary"),
    tx("fk-okt", "2026-10-10", 500_000, "parental_benefit"),
    tx("lon-nov", "2026-11-03", 3_300_000, "salary"),
    tx("swish", "2025-12-15", 20_000, "other"),
    tx("gammal", "2025-11-15", 99_900, "other"),
  ]);
});

async function get(path: string, method = "GET", env: Partial<Env> = {}) {
  const context: RouteContext = {
    waitUntil: () => undefined,
    sync: { logger: captureLogs().logger, clock: fixedClock("2026-11-04T10:00:00.000Z"), newId: () => "x", providerFor: () => null },
    connectorFor: () => null,
  };
  const headers = new Headers({ "cf-access-jwt-assertion": await signToken(key) });
  if (method !== "GET") {
    headers.set("origin", ORIGIN);
    headers.set("x-kronkoll", "1");
  }
  return handle(new Request(`${ORIGIN}${path}`, { method, headers }), configuredEnv({ DB: db, ...env }), guardDeps, context);
}

const zero = (period: string) => ({ period, salary_minor: 0, parental_benefit_minor: 0, other_minor: 0 });

describe("inkomst per månad (KK-22-B)", () => {
  it("ger de senaste 12 månaderna som standard, med noll för månader utan inkomst", async () => {
    const { months } = await (await get("/api/income")).json<{ months: { period: string }[] }>();
    expect(months.map((m) => m.period)).toEqual([
      "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11",
    ]);
    expect(months[0]).toEqual({ period: "2025-12", salary_minor: 0, parental_benefit_minor: 0, other_minor: 20_000 });
    expect(months[1]).toEqual(zero("2026-01"));
    expect(months.slice(-2)).toEqual([
      { period: "2026-10", salary_minor: 3_300_000, parental_benefit_minor: 500_000, other_minor: 0 },
      { period: "2026-11", salary_minor: 3_300_000, parental_benefit_minor: 0, other_minor: 0 },
    ]);
  });

  it("tar ett eget intervall på upp till 24 månader", async () => {
    expect(await (await get("/api/income?from=2026-09&to=2026-10")).json()).toEqual({
      months: [zero("2026-09"), { period: "2026-10", salary_minor: 3_300_000, parental_benefit_minor: 500_000, other_minor: 0 }],
    });
    const { months } = await (await get("/api/income?from=2024-12&to=2026-11")).json<{ months: unknown[] }>();
    expect(months).toHaveLength(24);
    expect(((await (await get("/api/income?to=2026-01")).json<{ months: { period: string }[] }>()).months[0])?.period).toBe("2025-02");
    expect((await (await get("/api/income?from=2026-11")).json<{ months: unknown[] }>()).months).toHaveLength(1);
  });

  it("vägrar ogiltiga intervall", async () => {
    for (const query of ["from=2026-13", "from=2026-1", "to=nov", "from=2026-11&to=2026-10", "from=2024-11&to=2026-11"]) {
      expect((await get(`/api/income?${query}`)).status).toBe(400);
    }
  });

  it("svarar 405 på fel metod och 503 när databasen inte svarar", async () => {
    expect((await get("/api/income", "POST")).status).toBe(405);
    const broken = { DB: { prepare: () => { throw new Error("nere"); } } as unknown as D1Database };
    expect((await get("/api/income", "GET", broken)).status).toBe(503);
  });
});

describe("posterna bakom en månads inkomst (KK-46-A)", () => {
  it("listar inbetalningarna som räknas, nyast först, med typ och källa", async () => {
    await db
      .prepare(`INSERT INTO transactions (id, account_id, fingerprint, status, last_seen_at, transaction_date, amount_minor, counterparty, description, income_type, income_source) VALUES ('fk-okt-2', 'a1', 'fp', 'booked', '2026-10-30', '2026-10-30', 40000, 'Försäkringskassan', 'Föräldrapenning <b>okt</b>', NULL, 'none')`)
      .run();
    const body = await (await get("/api/income/2026-10")).json<{ period: string; items: Record<string, unknown>[] }>();
    expect(body.period).toBe("2026-10");
    expect(body.items).toEqual([
      { id: "fk-okt-2", date: "2026-10-30", amount_minor: 40_000, counterparty: "Försäkringskassan", description: "Föräldrapenning <b>okt</b>", income_type: null, income_source: "none", status: "booked" },
      { id: "lon-okt", date: "2026-10-24", amount_minor: 3_300_000, counterparty: "", description: "", income_type: "salary", income_source: "template", status: "booked" },
      { id: "fk-okt", date: "2026-10-10", amount_minor: 500_000, counterparty: "", description: "", income_type: "parental_benefit", income_source: "template", status: "booked" },
    ]);
  });

  it("posterna summerar till månadens belopp, och interna överföringar, utgifter och borttagna räknas inte", async () => {
    await db.batch([
      db.prepare(`INSERT INTO transactions (id, account_id, fingerprint, status, last_seen_at, transaction_date, amount_minor, is_internal_transfer) VALUES ('intern', 'a1', 'fp', 'booked', '2026-10-12', '2026-10-12', 100000, 1)`),
      db.prepare(`INSERT INTO transactions (id, account_id, fingerprint, status, last_seen_at, transaction_date, amount_minor) VALUES ('utgift', 'a1', 'fp', 'booked', '2026-10-12', '2026-10-12', -50000)`),
      db.prepare(`INSERT INTO transactions (id, account_id, fingerprint, status, last_seen_at, transaction_date, amount_minor) VALUES ('borta', 'a1', 'fp', 'removed', '2026-10-12', '2026-10-12', 70000)`),
    ]);
    const { items } = await (await get("/api/income/2026-10")).json<{ items: { id: string; amount_minor: number }[] }>();
    expect(items.map((i) => i.id)).toEqual(["lon-okt", "fk-okt"]);
    const { months } = await (await get("/api/income?from=2026-10&to=2026-10")).json<{ months: { salary_minor: number; parental_benefit_minor: number; other_minor: number }[] }>();
    const month = months[0];
    expect(items.reduce((sum, i) => sum + i.amount_minor, 0)).toBe((month?.salary_minor ?? 0) + (month?.parental_benefit_minor ?? 0) + (month?.other_minor ?? 0));
  });

  it("en månad utan inkomst ger en tom lista", async () => {
    expect(await (await get("/api/income/2026-01")).json()).toEqual({ period: "2026-01", items: [] });
  });

  it("vägrar en ogiltig månad, fel metod och svarar 503 när databasen inte svarar", async () => {
    for (const period of ["2026-13", "2026-1", "november"]) expect((await get(`/api/income/${period}`)).status).toBe(400);
    expect((await get("/api/income/2026-10", "POST")).status).toBe(405);
    const broken = { DB: { prepare: () => { throw new Error("nere"); } } as unknown as D1Database };
    expect((await get("/api/income/2026-10", "GET", broken)).status).toBe(503);
  });
});
