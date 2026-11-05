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
let seq = 0;

const kr = (amount: number) => amount * 100;

beforeAll(async () => {
  ({ db, dispose } = await migratedDb());
  key = await createTestKey("leave-key");
  const { fetchImpl } = jwksFetch(key);
  guardDeps = {
    verifierFor: () => cachedVerifier({ issuer: ISSUER, audience: AUD, allowedEmails: [INVITED], appOrigin: ORIGIN }, fetchImpl),
    logger: captureLogs().logger,
  };
});
afterAll(async () => {
  await dispose();
});

/** Påhittad lön på 33 000 kr i augusti–oktober och en budget på 32 000 kr i november (KK-13). */
beforeEach(async () => {
  await db.batch([
    db.prepare(`DELETE FROM leave_periods`),
    db.prepare(`DELETE FROM savings_goals`),
    db.prepare(`DELETE FROM budget_lines`),
    db.prepare(`DELETE FROM bank_connections`),
    db.prepare(`INSERT INTO bank_connections (id, provider, status) VALUES ('c1', 'enablebanking', 'active')`),
    db.prepare(`INSERT INTO accounts (id, connection_id, display_name, type) VALUES ('a1', 'c1', 'Privatkonto', 'checking')`),
    db.prepare(`INSERT INTO budget_lines (period, category_id, amount_minor) VALUES ('2026-11', 'boende', ?)`).bind(kr(32000)),
    ...["2026-07-24", "2026-08-25", "2026-09-25", "2026-10-23"].map((date, i) =>
      db
        .prepare(
          `INSERT INTO transactions (id, account_id, fingerprint, status, last_seen_at, transaction_date, amount_minor, income_type, income_source)
           VALUES (?, 'a1', 'fp', 'booked', ?, ?, ?, 'salary', 'template')`,
        )
        .bind(`lon${String(i)}`, date, date, kr(33000)),
    ),
  ]);
});

async function call(method: string, path: string, body?: unknown, env: Partial<Env> = {}) {
  const context: RouteContext = {
    waitUntil: () => undefined,
    sync: { logger: captureLogs().logger, clock: fixedClock("2026-11-04T10:00:00.000Z"), newId: () => `l${String(++seq)}`, providerFor: () => null },
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

const SPRING = { from: "2027-03-01", to: "2027-08-31", days_per_week: 5, sgi_annual_minor: kr(540000), employer_topup_pct: 10, tax_rate_pct: 31.5 };

describe("planerad föräldraledighet (KK-23)", () => {
  it("sparar en period och ger uppskattning, skillnad mot normal månad och underskott per månad (KK-23-A)", async () => {
    const res = await call("POST", "/api/leave-periods", SPRING);
    expect(res.status).toBe(201);
    const body = await res.json<Record<string, unknown> & { estimate: { months: unknown[] }; impacts: unknown[] }>();
    expect(body).toMatchObject({ ...SPRING, override_net_monthly_minor: null, estimate: { disclaimer: "Uppskattning – inte ett besked från Försäkringskassan", normal_net_monthly_minor: kr(33000) } });
    expect(body.estimate.months).toHaveLength(6);
    // 23 dagar × 1 148 kr + 4 500 kr föräldralön, minus 31,5 % skatt.
    expect(body.estimate.months[0]).toEqual({
      period: "2027-03",
      leave_days: 31,
      withdrawal_days: 23,
      benefit_gross_minor: 2_640_400,
      topup_gross_minor: 450_000,
      net_minor: 2_116_924,
      source: "estimate",
      params_year: 2027,
      params_fallback: false,
      income_minor: 2_116_924,
      delta_vs_normal_minor: -1_183_076,
    });
    expect(body.impacts[0]).toEqual({ type: "budget", period: "2027-03", budget_minor: kr(32000), income_minor: 2_116_924, shortfall_minor: 1_083_076 });
    expect(await (await call("GET", "/api/leave-periods")).json()).toEqual({ items: [body] });
  });

  it("visar hur ledigheten försenar varje sparmål (KK-23-C)", async () => {
    // Påhittade mål: 10 000 kr/mån de senaste tre månaderna och 30 000 kr sparat mot 150 000 kr i nov. 2027, ett uppnått och två utan takt.
    await db.batch([
      db.prepare(`INSERT INTO savings_goals (id, name, target_minor, target_date, source, initial_minor) VALUES ('resa', 'Resa', ?, '2027-11-30', 'manual', 0)`).bind(kr(150000)),
      db.prepare(`INSERT INTO savings_goals (id, name, target_minor, target_date, source, initial_minor) VALUES ('klart', 'Klart', ?, NULL, 'manual', ?)`).bind(kr(1000), kr(1000)),
      db.prepare(`INSERT INTO savings_goals (id, name, target_minor, target_date, source, initial_minor) VALUES ('still', 'Still', ?, NULL, 'manual', 0)`).bind(kr(1000)),
      db.prepare(`INSERT INTO savings_goals (id, name, target_minor, target_date, source, initial_minor) VALUES ('sent', 'Sent', ?, '2027-01-31', 'manual', 0)`).bind(kr(1000)),
      ...["2026-08-15", "2026-09-15", "2026-10-15"].map((date, i) =>
        db.prepare(`INSERT INTO goal_contributions (id, goal_id, date, amount_minor) VALUES (?, 'resa', ?, ?)`).bind(`gc${String(i)}`, date, kr(10000)),
      ),
    ]);
    const body = await (await call("POST", "/api/leave-periods", SPRING)).json<{ impacts: { type: string; goal_id?: string }[] }>();
    // Mål som skapas i samma millisekund har ingen bestämd ordning, så de hämtas på id.
    const goals = new Map(body.impacts.filter((i) => i.type === "goal").map((g) => [g.goal_id, g]));
    expect([...goals.keys()].sort()).toEqual(["klart", "resa", "sent", "still"]);
    // Ungefär 62 % av lönen i sex månader: cirka 3 800 kr mindre sparat per månad, och målet nås 3 månader senare.
    expect(goals.get("resa")).toEqual({
      type: "goal",
      goal_id: "resa",
      name: "Resa",
      lost_saving_minor: 2_294_028,
      delay_months: 3,
      reach_period_before: "2027-11",
      reach_period_after: "2028-02",
      on_track_before: true,
      on_track_after: false,
    });
    expect(goals.get("klart")).toMatchObject({ lost_saving_minor: 0, delay_months: null, reach_period_after: null, on_track_before: true, on_track_after: true });
    expect(goals.get("still")).toMatchObject({ lost_saving_minor: 0, delay_months: null, on_track_after: null });
    expect(goals.get("sent")).toMatchObject({ on_track_after: false });
    await db.prepare(`DELETE FROM savings_goals`).run();
  });

  it("ett manuellt belopp vinner (KK-23-B), och ett år utan parametrar varnar", async () => {
    const res = await call("POST", "/api/leave-periods", { ...SPRING, from: "2028-01-01", to: "2028-01-31", override_net_monthly_minor: kr(20000) });
    const manual = await res.json<{ estimate: { months: unknown[] } }>();
    expect(manual.estimate.months[0]).toMatchObject({ net_minor: kr(20000), source: "manual", params_year: null });
    const estimated = await (await call("POST", "/api/leave-periods", { ...SPRING, from: "2028-01-01", to: "2028-01-31", employer_topup_pct: undefined })).json<typeof manual>();
    expect(estimated.estimate.months[0]).toMatchObject({ source: "estimate", params_year: 2027, params_fallback: true, topup_gross_minor: 0 });
  });

  it("tar bort en period", async () => {
    const { id } = await (await call("POST", "/api/leave-periods", SPRING)).json<{ id: string }>();
    expect((await call("DELETE", `/api/leave-periods/${id}`)).status).toBe(204);
    expect((await call("DELETE", `/api/leave-periods/${id}`)).status).toBe(404);
    expect(await (await call("GET", "/api/leave-periods")).json()).toEqual({ items: [] });
  });

  it("vägrar ogiltiga perioder", async () => {
    for (const body of [
      "inte json",
      null,
      { ...SPRING, from: "2027-02-30" },
      { ...SPRING, to: "31 aug" },
      { ...SPRING, days_per_week: 8 },
      { ...SPRING, days_per_week: "5" },
      { ...SPRING, sgi_annual_minor: -1 },
      { ...SPRING, sgi_annual_minor: 1.5 },
      { ...SPRING, employer_topup_pct: 101 },
      { ...SPRING, tax_rate_pct: undefined },
      { ...SPRING, override_net_monthly_minor: -1 },
    ]) {
      expect((await call("POST", "/api/leave-periods", body)).status).toBe(400);
    }
    expect(await (await call("POST", "/api/leave-periods", { ...SPRING, to: "2027-02-28" })).json()).toEqual({ error: "to_before_from" });
    expect(await (await call("POST", "/api/leave-periods", { ...SPRING, to: "2029-03-01" })).json()).toEqual({ error: "period_too_long" });
    expect((await call("POST", "/api/leave-periods", { ...SPRING, to: "2029-02-28" })).status).toBe(201);
  });

  it("svarar 405 på fel metod och 503 när databasen inte svarar", async () => {
    expect((await call("PUT", "/api/leave-periods", SPRING)).status).toBe(405);
    expect((await call("GET", "/api/leave-periods/l1")).status).toBe(405);
    const broken = { DB: { prepare: () => { throw new Error("nere"); } } as unknown as D1Database };
    expect((await call("GET", "/api/leave-periods", undefined, broken)).status).toBe(503);
    expect((await call("POST", "/api/leave-periods", SPRING, broken)).status).toBe(503);
    expect((await call("DELETE", "/api/leave-periods/l1", undefined, broken)).status).toBe(503);
  });
});
