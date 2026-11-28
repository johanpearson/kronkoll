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
      match_patterns: [],
      category_id: null,
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

describe("lånens matchningstexter och betalningar (KK-59)", () => {
  // Påhittade betalningar med påhittat kontonummer (KK-13, KK-59-E). Juni ligger längre bort än synkens 60 dagar.
  beforeAll(async () => {
    await db.batch([
      db.prepare(`INSERT INTO bank_connections (id, provider, aspsp_name, status) VALUES ('c1', 'enablebanking', 'Skandia', 'active')`),
      db.prepare(`INSERT INTO accounts (id, connection_id, display_name, type) VALUES ('acc_1', 'c1', 'Privatkonto', 'checking')`),
    ]);
  });
  beforeEach(async () => {
    const rows: [string, string, number, string][] = [
      ["nov", "2026-11-02", -812_500, "Betalning 9020 1234567"],
      ["jun", "2026-06-27", -812_500, "BG 9020.12.34567"],
      ["ica", "2026-11-03", -41_250, "<b>ICA</b> NARA EXEMPEL"],
    ];
    await db.batch([
      db.prepare(`DELETE FROM transactions`),
      ...rows.map(([id, date, amount, description]) =>
        db
          .prepare(
            `INSERT INTO transactions (id, account_id, fingerprint, status, last_seen_at, transaction_date, booking_date, amount_minor, description)
             VALUES (?, 'acc_1', 'fp', 'booked', ?, ?, ?, ?, ?)`,
          )
          .bind(id, date, date, date, amount, description),
      ),
    ]);
    await call("PUT", "/api/loans/bolan", BOLAN);
  });
  const linked = async () => (await db.prepare(`SELECT id, loan_id AS loan, category_id AS c FROM transactions ORDER BY id`).all()).results;

  it("förhandsvisar hur många betalningar texterna träffar, med de senaste som exempel och bankens text oförändrad (KK-59-A)", async () => {
    const res = await call("POST", "/api/loans/preview", { match_patterns: ["9020-12 345 67"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      count: 2,
      examples: [
        { id: "nov", date: "2026-11-02", amount_minor: -812_500, counterparty: "", description: "Betalning 9020 1234567" },
        { id: "jun", date: "2026-06-27", amount_minor: -812_500, counterparty: "", description: "BG 9020.12.34567" },
      ],
    });
    expect(await (await call("POST", "/api/loans/preview", { match_patterns: ["<b>ICA</b>"] })).json()).toMatchObject({ examples: [{ description: "<b>ICA</b> NARA EXEMPEL" }] });
    expect(await linked()).toEqual([{ id: "ica", loan: null, c: null }, { id: "jun", loan: null, c: null }, { id: "nov", loan: null, c: null }]);
  });

  it("sparar texterna och kopplar hela historiken, med Boende › Låneränta som standardkategori (KK-59-A, KK-59-B)", async () => {
    const res = await call("PUT", "/api/loans/bolan/matching", { match_patterns: ["9020-12 345 67"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ match_patterns: ["9020-12 345 67"], category_id: "boende-laneranta", linked: 2 });
    expect(await linked()).toEqual([
      { id: "ica", loan: null, c: null },
      { id: "jun", loan: "bolan", c: "boende-laneranta" },
      { id: "nov", loan: "bolan", c: "boende-laneranta" },
    ]);
    // Utan texter tas de automatiska kopplingarna bort. Med kategori null kopplas det bara.
    expect(await (await call("PUT", "/api/loans/bolan/matching", { match_patterns: [] })).json()).toMatchObject({ linked: 2 });
    expect(await (await call("PUT", "/api/loans/bolan/matching", { match_patterns: ["9020-12 345 67"], category_id: null })).json()).toMatchObject({ category_id: null, linked: 2 });
    expect(await linked()).toEqual([{ id: "ica", loan: null, c: null }, { id: "jun", loan: "bolan", c: null }, { id: "nov", loan: "bolan", c: null }]);
  });

  it("listar varje lån med texterna, kategorin och Betalt denna period (KK-59-C)", async () => {
    await call("PUT", "/api/loans/bolan/matching", { match_patterns: ["9020-12 345 67"] });
    await call("PUT", "/api/loans/bil", BIL);
    const body = await (await call("GET", "/api/loans")).json<{ loans: Record<string, unknown>[] }>();
    expect(body.loans.map((l) => [l["id"], l["match_patterns"], l["category_id"], l["paid"]])).toEqual([
      ["bolan", ["9020-12 345 67"], "boende-laneranta", { paid_minor: 812_500, last_paid_on: "2026-11-02", missing: false }],
      ["bil", [], null, { paid_minor: 0, last_paid_on: null, missing: false }],
    ]);
  });

  it("felaktiga texter, en okänd kategori och ett lån som inte finns ger 400 och 404", async () => {
    const bad: unknown[] = [
      "inte json",
      { match_patterns: "9020" },
      { match_patterns: [5] },
      { match_patterns: ["x".repeat(61)] },
      { match_patterns: Array.from({ length: 11 }, (_, i) => `text ${String(i)}`) },
      { match_patterns: ["9020"], category_id: 5 },
      { match_patterns: ["9020"], category_id: "finns-inte" },
    ];
    for (const body of bad) expect((await call("PUT", "/api/loans/bolan/matching", body)).status, JSON.stringify(body)).toBe(400);
    for (const body of bad.slice(0, 5)) expect((await call("POST", "/api/loans/preview", body)).status, JSON.stringify(body)).toBe(400);
    expect((await call("PUT", "/api/loans/saknas/matching", { match_patterns: [] })).status).toBe(404);
  });

  it("fel metod ger 405 och en databas som inte svarar 503", async () => {
    expect((await call("GET", "/api/loans/preview")).headers.get("allow")).toBe("POST");
    expect((await call("GET", "/api/loans/bolan/matching")).headers.get("allow")).toBe("PUT");
    const broken = { prepare: () => { throw new Error("nere"); }, batch: () => { throw new Error("nere"); } } as unknown as D1Database;
    expect((await call("POST", "/api/loans/preview", { match_patterns: [] }, { DB: broken })).status).toBe(503);
    expect((await call("PUT", "/api/loans/bolan/matching", { match_patterns: [] }, { DB: broken })).status).toBe(503);
  });
});
