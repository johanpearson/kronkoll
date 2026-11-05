import type { D1Database } from "@cloudflare/workers-types";
import { accountRepository, connectionRepository, deriveKeys } from "@kronkoll/adapter-d1";
import { migratedDb, randomSecret } from "@kronkoll/adapter-d1/test-support";
import { CATEGORY_TEMPLATE, fixedClock, normalizeCounterparty } from "@kronkoll/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cachedVerifier, type GuardDeps } from "./access.ts";
import { handle, type RouteContext } from "./index.ts";
import { AUD, INVITED, ISSUER, ORIGIN, captureLogs, configuredEnv, createTestKey, jwksFetch, signToken, type TestKey } from "./test-support.ts";

let db: D1Database;
let dispose: () => Promise<void>;
let key: TestKey;
let guardDeps: GuardDeps;

const category = (name: string) => (CATEGORY_TEMPLATE.find((c) => c.name === name && c.parentId !== null) ?? { id: "?" }).id;
const RESTAURANG = category("Restaurang & café");
const HYRA = category("Hyra & avgift");
const GYM = "PAHITTAT GYM 12, STOCKHOLM";

beforeAll(async () => {
  ({ db, dispose } = await migratedDb());
  const keys = await deriveKeys(randomSecret());
  key = await createTestKey("insights-key");
  const { fetchImpl } = jwksFetch(key);
  guardDeps = {
    verifierFor: () => cachedVerifier({ issuer: ISSUER, audience: AUD, allowedEmails: [INVITED], appOrigin: ORIGIN }, fetchImpl),
    logger: captureLogs().logger,
  };
  await connectionRepository(db, keys).create({ id: "c1", provider: "enablebanking", aspspName: "Skandia" });
  await accountRepository(db, keys).upsertFromBank({ connectionId: "c1", providerUid: "u1", iban: null, name: "Privatkonto", type: "checking", balanceMinor: 0 }, () => "acc_1");
  // Påhittade transaktioner (KK-13): hyra, Netflix och ett gym varje månad, där gymmet som hos Skandia bara står i
  // meddelandet. Restaurang 2 500 kr i augusti–oktober och 4 000 kr i november.
  const rows: [string, string, number, string, string, string | null, number][] = [];
  for (const [i, month] of ["08", "09", "10", "11"].entries()) {
    rows.push([`hyra${month}`, `2026-${month}-01`, -890000, "Hyresvärden AB", "", HYRA, 0]);
    rows.push([`rest${month}`, `2026-${month}-12`, i === 3 ? -400000 : -250000, "Restaurang Påhittad", "", RESTAURANG, 0]);
    if (i < 3) rows.push([`netflix${month}`, `2026-${month}-19`, -14900, "Netflix", "", "abonnemang-streaming", 0]);
    if (i < 3) rows.push([`gym${month}`, `2026-${month}-28`, -29900, "", GYM, null, 0]);
  }
  rows.push(["ica", "2026-11-03", -30000, "", "ICA NARA PAHITTAD, STOCKHOLM", "mat-livsmedel", 0], ["intern", "2026-11-10", -500000, "", "Till sparkonto", null, 1]);
  await db.batch(
    rows.map(([id, date, amount, counterparty, description, cat, internal]) =>
      db
        .prepare(
          `INSERT INTO transactions (id, account_id, fingerprint, status, last_seen_at, transaction_date, booking_date, amount_minor, counterparty, counterparty_norm, description, category_id, category_source, is_internal_transfer)
           VALUES (?, 'acc_1', 'fp', 'booked', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, date, date, date, amount, counterparty, normalizeCounterparty(counterparty), description, cat, cat === null ? "none" : "template", internal),
    ),
  );
});
afterAll(async () => {
  await dispose();
});

async function call(method: string, path: string) {
  const context: RouteContext = {
    waitUntil: () => undefined,
    sync: { logger: captureLogs().logger, clock: fixedClock("2026-11-15T10:00:00.000Z"), newId: () => "x", providerFor: () => null },
    connectorFor: () => null,
  };
  const headers = new Headers({ "cf-access-jwt-assertion": await signToken(key), origin: ORIGIN, "x-kronkoll": "1" });
  return handle(new Request(`${ORIGIN}${path}`, { method, headers }), configuredEnv({ DB: db }), guardDeps, context);
}

describe("insikter (#41, KK-24)", () => {
  it("visar avvikelser, återkommande dragningar och periodens största utgifter", async () => {
    const res = await call("GET", "/api/insights?period=2026-11");
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body["period"]).toEqual({ key: "2026-11", start: "2026-11-01", end: "2026-11-30" });
    expect(body["history_periods"]).toEqual(["2026-10", "2026-09", "2026-08"]);
    expect(body["anomalies"]).toEqual([{ category_id: RESTAURANG, actual_minor: 400000, baseline_minor: 250000, diff_minor: 150000, pct: 60 }]);
    expect(body["top_expenses"]).toEqual([
      { id: "hyra11", date: "2026-11-01", name: "Hyresvärden AB", amount_minor: 890000, category_id: HYRA, split: false },
      { id: "rest11", date: "2026-11-12", name: "Restaurang Påhittad", amount_minor: 400000, category_id: RESTAURANG, split: false },
      { id: "ica", date: "2026-11-03", name: "ICA NARA PAHITTAD, STOCKHOLM", amount_minor: 30000, category_id: "mat-livsmedel", split: false },
    ]);
    expect(body["top_categories"]).toEqual([
      { category_id: "boende", amount_minor: 890000 },
      { category_id: "mat", amount_minor: 430000 },
    ]);
  });

  it("känner igen återkommande dragningar, även när butiken bara står i meddelandet", async () => {
    const body = await (await call("GET", "/api/insights")).json<{ recurring: Record<string, unknown>[]; recurring_yearly_minor: number }>();
    expect(body.recurring).toEqual([
      { name: "Hyresvärden AB", interval: "monthly", amount_minor: 890000, last_date: "2026-11-01", next_expected: "2026-12-01", yearly_minor: 10680000, occurrences: 4 },
      { name: normalizeCounterparty(GYM), interval: "monthly", amount_minor: 29900, last_date: "2026-10-28", next_expected: "2026-11-28", yearly_minor: 358800, occurrences: 3 },
      { name: "Netflix", interval: "monthly", amount_minor: 14900, last_date: "2026-10-19", next_expected: "2026-11-19", yearly_minor: 178800, occurrences: 3 },
    ]);
    expect(body.recurring_yearly_minor).toBe(10680000 + 358800 + 178800);
  });

  it("ger en tom gammal period men samma återkommande dragningar, som alltid räknas från i dag", async () => {
    const body = await (await call("GET", "/api/insights?period=2024-05")).json<Record<string, unknown[]>>();
    expect([body["anomalies"], body["top_expenses"], body["top_categories"]]).toEqual([[], [], []]);
    expect(body["recurring"]).toHaveLength(3);
  });

  it("ger den pågående perioden utan parameter, 400 för en ogiltig period och 405 för annat än GET", async () => {
    expect((await (await call("GET", "/api/insights")).json<{ period: { key: string } }>()).period.key).toBe("2026-11");
    expect((await call("GET", "/api/insights?period=2026-13")).status).toBe(400);
    expect((await call("POST", "/api/insights")).status).toBe(405);
  });

  it("svarar 503 när databasen inte går att nå", async () => {
    const res = await handle(
      new Request(`${ORIGIN}/api/insights`, { headers: { "cf-access-jwt-assertion": await signToken(key) } }),
      configuredEnv({ DB: { prepare: () => { throw new Error("nere"); } } as unknown as D1Database }),
      guardDeps,
      { waitUntil: () => undefined, sync: { logger: captureLogs().logger, clock: fixedClock("2026-11-15T10:00:00.000Z"), newId: () => "x", providerFor: () => null }, connectorFor: () => null },
    );
    expect(res.status).toBe(503);
  });
});
