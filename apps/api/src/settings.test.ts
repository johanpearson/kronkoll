import type { D1Database } from "@cloudflare/workers-types";
import { settingsRepository } from "@kronkoll/adapter-d1";
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
  key = await createTestKey("settings-key");
  const { fetchImpl } = jwksFetch(key);
  guardDeps = {
    verifierFor: () => cachedVerifier({ issuer: ISSUER, audience: AUD, allowedEmails: [INVITED], appOrigin: ORIGIN }, fetchImpl),
    logger: captureLogs().logger,
  };
});
afterAll(async () => {
  await dispose();
});
beforeEach(async () => {
  await settingsRepository(db).setBudgetPeriodStartDay(1);
});

async function call(method: string, body?: unknown, env: Partial<Env> = {}, csrf = true) {
  const context: RouteContext = {
    waitUntil: () => undefined,
    sync: { logger: captureLogs().logger, clock: fixedClock("2026-12-28T10:00:00.000Z"), newId: () => "x", providerFor: () => null },
    connectorFor: () => null,
  };
  const headers = new Headers({ "cf-access-jwt-assertion": await signToken(key), "content-type": "application/json" });
  if (method !== "GET" && csrf) {
    headers.set("origin", ORIGIN);
    headers.set("x-kronkoll", "1");
  }
  const init = { method, headers, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) };
  return handle(new Request(`${ORIGIN}/api/settings`, init), configuredEnv({ DB: db, ...env }), guardDeps, context);
}

describe("GET /api/settings (KK-34)", () => {
  it("ger startdagen och perioden som pågår, kalendermånad som standard", async () => {
    const res = await call("GET");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ budget_period_start_day: 1, current_period: { key: "2026-12", start: "2026-12-01", end: "2026-12-31" } });
  });

  it("svarar 503 utan detaljer när databasen inte går att läsa", async () => {
    const broken = { prepare: () => { throw new Error("D1 nere"); } } as unknown as D1Database;
    const res = await call("GET", undefined, { DB: broken });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
  });
});

describe("PATCH /api/settings (KK-34)", () => {
  it("sparar lönedagen och svarar med den nya perioden, flyttad till bankdag före en helg (KK-34-A)", async () => {
    const res = await call("PATCH", { budget_period_start_day: 25 });
    expect(res.status).toBe(200);
    // 25 dec 2026 är juldagen, så perioden börjar onsdag 23 dec.
    expect(await res.json()).toEqual({ budget_period_start_day: 25, current_period: { key: "2027-01", start: "2026-12-23", end: "2027-01-24" } });
    expect((await settingsRepository(db).get()).budgetPeriodStartDay).toBe(25);
  });

  it.each([
    ["0", { budget_period_start_day: 0 }],
    ["29", { budget_period_start_day: 29 }],
    ["ett decimaltal", { budget_period_start_day: 2.5 }],
    ["en sträng", { budget_period_start_day: "25" }],
    ["inget värde", {}],
    ["inte JSON", "{"],
  ])("%s ger 400 och ändrar ingenting", async (_, body) => {
    const res = await call("PATCH", body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
    expect((await settingsRepository(db).get()).budgetPeriodStartDay).toBe(1);
  });

  it("kräver CSRF-skydd, och andra metoder ger 405", async () => {
    expect((await call("PATCH", { budget_period_start_day: 25 }, {}, false)).status).toBe(403);
    const res = await call("PUT", { budget_period_start_day: 25 });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, PATCH");
  });

  it("svarar 503 utan detaljer när databasen inte går att skriva", async () => {
    const broken = { prepare: () => { throw new Error("D1 nere"); } } as unknown as D1Database;
    const res = await call("PATCH", { budget_period_start_day: 25 }, { DB: broken });
    expect(res.status).toBe(503);
  });
});
