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
  key = await createTestKey("loans-key");
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
  await db.prepare(`DELETE FROM loans`).run();
});

async function call(method: string, path: string, body?: unknown, env: Partial<Env> = {}) {
  const context: RouteContext = {
    waitUntil: () => undefined,
    sync: { logger: captureLogs().logger, clock: fixedClock("2026-11-04T10:00:00.000Z"), newId: () => "x", providerFor: () => null },
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

/** Påhittade lån enligt planens exempel (KK-13). */
const BOLAN = { name: "Bolån", lender: "Exempelbanken", balance_minor: 240_000_000, interest_rate_bp: 350, rate_fixed_until: "2026-12-15", amortization_minor: 400_000 };
const BIL = { name: "Billån", balance_minor: 8_600_000, interest_rate_bp: 695, amortization_minor: 245_000 };

describe("lån (#72, KK-36)", () => {
  it("lägger till ett lån och visar månadskostnad, ränta, amortering och bindningstid (KK-36-B, KK-36-C)", async () => {
    const res = await call("PUT", "/api/loans/bolan", BOLAN);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      id: "bolan",
      ...BOLAN,
      monthly_interest_minor: 700_000,
      monthly_amortization_minor: 400_000,
      monthly_cost_minor: 1_100_000,
      rate_fixed: true,
      rate_fixed_days_left: 41,
      rate_fixed_ending: true,
    });
  });

  it("listar lånen med totalsummor, och rörlig ränta flaggas inte", async () => {
    await call("PUT", "/api/loans/bolan", BOLAN);
    await call("PUT", "/api/loans/bil", BIL);
    const body = await (await call("GET", "/api/loans")).json<{ loans: Record<string, unknown>[] } & Record<string, unknown>>();
    expect(body.loans.map((l) => l["id"])).toEqual(["bolan", "bil"]);
    expect(body.loans[1]).toMatchObject({ lender: null, rate_fixed_until: null, monthly_interest_minor: 49_808, rate_fixed: false, rate_fixed_days_left: null, rate_fixed_ending: false });
    expect(body).toMatchObject({
      total_balance_minor: 248_600_000,
      total_monthly_interest_minor: 749_808,
      total_monthly_amortization_minor: 645_000,
      total_monthly_cost_minor: 1_394_808,
    });
  });

  it("ändrar ett lån med samma id och ger 200, och ett tomt eller blankt namn på långivaren blir inget", async () => {
    await call("PUT", "/api/loans/bolan", BOLAN);
    const res = await call("PUT", "/api/loans/bolan", { ...BOLAN, name: " Bolån del 1 ", lender: "  ", balance_minor: 239_600_000 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: "Bolån del 1", lender: null, balance_minor: 239_600_000 });
    expect((await (await call("GET", "/api/loans")).json<{ loans: unknown[] }>()).loans).toHaveLength(1);
  });

  it("tar bort ett lån, och ett lån som inte finns ger 404", async () => {
    await call("PUT", "/api/loans/bolan", BOLAN);
    expect((await call("DELETE", "/api/loans/bolan")).status).toBe(204);
    expect((await call("DELETE", "/api/loans/bolan")).status).toBe(404);
    expect(await (await call("GET", "/api/loans")).json()).toMatchObject({ loans: [], total_monthly_cost_minor: 0 });
  });

  it("felaktiga lån ger 400 och sparas inte", async () => {
    const bad: unknown[] = [
      "inte json",
      null,
      { ...BOLAN, name: " " },
      { ...BOLAN, name: "x".repeat(61) },
      { ...BOLAN, lender: 5 },
      { ...BOLAN, balance_minor: -1 },
      { ...BOLAN, balance_minor: 1.5 },
      { ...BOLAN, interest_rate_bp: 3.5 },
      { ...BOLAN, interest_rate_bp: 10_001 },
      { ...BOLAN, interest_rate_bp: -1 },
      { ...BOLAN, amortization_minor: -1 },
      { ...BOLAN, rate_fixed_until: "2026-02-30" },
    ];
    for (const body of bad) expect((await call("PUT", "/api/loans/bolan", body)).status, JSON.stringify(body)).toBe(400);
    expect(await (await call("GET", "/api/loans")).json()).toMatchObject({ loans: [] });
  });

  it("fel metod ger 405 och en databas som inte svarar 503", async () => {
    expect((await call("POST", "/api/loans")).headers.get("allow")).toBe("GET");
    expect((await call("GET", "/api/loans/bolan")).headers.get("allow")).toBe("PUT, DELETE");
    const broken = { prepare: () => { throw new Error("nere"); }, batch: () => { throw new Error("nere"); } } as unknown as D1Database;
    expect((await call("GET", "/api/loans", undefined, { DB: broken })).status).toBe(503);
    expect((await call("PUT", "/api/loans/bolan", BOLAN, { DB: broken })).status).toBe(503);
    expect((await call("DELETE", "/api/loans/bolan", undefined, { DB: broken })).status).toBe(503);
  });
});
