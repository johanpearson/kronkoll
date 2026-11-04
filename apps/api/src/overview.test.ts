import type { D1Database } from "@cloudflare/workers-types";
import { accountRepository, budgetRepository, connectionRepository, deriveKeys, settingsRepository } from "@kronkoll/adapter-d1";
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
  key = await createTestKey("overview-key");
  const { fetchImpl } = jwksFetch(key);
  guardDeps = {
    verifierFor: () => cachedVerifier({ issuer: ISSUER, audience: AUD, allowedEmails: [INVITED], appOrigin: ORIGIN }, fetchImpl),
    logger: captureLogs().logger,
  };
  // Påhittade kopplingar, konton och transaktioner (KK-13).
  const connections = connectionRepository(db, keys);
  await connections.create({ id: "c1", provider: "enablebanking", aspspName: "Skandia" });
  await connections.activate("c1", { sessionId: "3f1d2c4b-0000-4000-8000-00000000abcd", consentExpiresOn: "2027-05-01" });
  await connections.recordSyncOutcome("c1", "ok", "2026-11-15T05:02:11.000Z");
  await connections.create({ id: "c2", provider: "enablebanking", aspspName: "SBAB" });
  const accounts = accountRepository(db, keys);
  await accounts.upsertFromBank({ connectionId: "c1", providerUid: "u1", iban: null, name: "Privatkonto", type: "checking", balanceMinor: 4831240 }, () => "acc_1");
  await accounts.upsertFromBank({ connectionId: "c1", providerUid: "u2", iban: null, name: "Spar", type: "savings", balanceMinor: 7400000 }, () => "acc_2");
  await accounts.upsertFromBank({ connectionId: "c1", providerUid: "u3", iban: null, name: "Kort", type: "credit_card", balanceMinor: null }, () => "acc_3");
  await db.prepare(`INSERT INTO accounts (id, connection_id, display_name, type, balance_minor, included) VALUES ('acc_4', 'c1', 'Lån', 'loan', -200000000, 0)`).run();
  await db.prepare(`UPDATE accounts SET nickname = 'Vardag' WHERE id = 'acc_1'`).run();
  const rows: [string, string, number, string | null, number][] = [
    ["lon", "2026-11-01", 4125000, "inkomst-lon", 0],
    ["ica", "2026-11-03", -41250, "mat-livsmedel", 0],
    ["okat", "2026-11-04", -10000, null, 0],
    ["intern", "2026-11-10", -500000, null, 1],
    ["okt", "2026-10-12", -300000, "mat-livsmedel", 0],
    ["gammal", "2025-11-30", -99900, "mat-livsmedel", 0],
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
  await budgetRepository(db).replace("2026-11", [{ categoryId: "mat", amountMinor: 600000 }, { categoryId: "boende", amountMinor: 400000 }], "manual");
});
afterAll(async () => {
  await dispose();
});
beforeEach(async () => {
  await settingsRepository(db).setBudgetPeriodStartDay(1);
});

async function call(path: string, env: Partial<Env> = {}, method = "GET") {
  const context: RouteContext = {
    waitUntil: () => undefined,
    sync: { logger: captureLogs().logger, clock: fixedClock("2026-11-15T10:00:00.000Z"), newId: () => "x", providerFor: () => null },
    connectorFor: () => null,
  };
  const headers = new Headers({ "cf-access-jwt-assertion": await signToken(key), origin: ORIGIN, "x-kronkoll": "1" });
  return handle(new Request(`${ORIGIN}${path}`, { method, headers }), configuredEnv({ DB: db, ...env }), guardDeps, context);
}

type Overview = Record<string, unknown> & { trend: { period: string; income_minor: number; expense_minor: number; net_minor: number }[] };

describe("GET /api/overview (KK-17)", () => {
  it("ger saldo, periodens in och ut, kvar att spendera och kopplingarnas status", async () => {
    const res = await call("/api/overview");
    expect(res.status).toBe(200);
    const body = await res.json<Overview>();
    expect({ ...body, trend: undefined, accounts: undefined }).toEqual({
      period: { key: "2026-11", start: "2026-11-01", end: "2026-11-30" },
      balance_minor: 12231240,
      income_minor: 4125000,
      expense_minor: 51250,
      net_minor: 4073750,
      budget_minor: 1000000,
      left_to_spend_minor: 948750,
      // 16 dagar kvar, 15–30 november: 948 750 / 16 = 59 296,875 → 59 296 öre.
      left_per_day_minor: 59296,
      days_left: 16,
      over: false,
      last_sync_at: "2026-11-15T05:02:11.000Z",
      connections: [{ id: "c1", bank: "Skandia", status: "active", consent_expires_on: "2027-05-01", consent_days_left: 167 }],
      trend: undefined,
      accounts: undefined,
    });
  });

  it("listar varje valt konto med namn, bank och saldo, och totalen är summan av dem som har saldo (KK-38)", async () => {
    const body = await (await call("/api/overview")).json<Overview>();
    expect(body.accounts).toEqual([
      { id: "acc_3", name: "Kort", bank: "Skandia", balance_minor: null },
      { id: "acc_2", name: "Spar", bank: "Skandia", balance_minor: 7400000 },
      { id: "acc_1", name: "Vardag", bank: "Skandia", balance_minor: 4831240 },
    ]);
    expect(body.balance_minor).toBe(7400000 + 4831240);
  });

  it("har trenden för de 12 senaste perioderna, äldst först (KK-17-C)", async () => {
    const { trend } = await (await call("/api/overview")).json<Overview>();
    expect(trend.map((t) => t.period)).toEqual(["2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"]);
    expect(trend[10]).toEqual({ period: "2026-10", income_minor: 0, expense_minor: 300000, net_minor: -300000 });
    expect(trend[11]).toMatchObject({ income_minor: 4125000, expense_minor: 51250 });
  });

  it("budget både på en huvudkategori och dess underkategori räknas en gång (KK-20-A)", async () => {
    const lines = [{ categoryId: "mat", amountMinor: 600000 }, { categoryId: "mat-livsmedel", amountMinor: 300000 }, { categoryId: "boende", amountMinor: 400000 }];
    await budgetRepository(db).replace("2026-11", lines, "manual");
    expect(await (await call("/api/overview")).json()).toMatchObject({ budget_minor: 1000000 });
    await budgetRepository(db).replace("2026-11", [{ categoryId: "mat", amountMinor: 600000 }, { categoryId: "boende", amountMinor: 400000 }], "manual");
  });

  it("en äldre period ger dess siffror, utan budget och utan dagar kvar", async () => {
    const body = await (await call("/api/overview?period=2026-10")).json<Overview>();
    expect(body).toMatchObject({ expense_minor: 300000, budget_minor: 0, left_to_spend_minor: -300000, left_per_day_minor: null, days_left: 0, over: true });
  });

  it("följer startdagen för budgetperioden (KK-34)", async () => {
    await settingsRepository(db).setBudgetPeriodStartDay(25);
    const body = await (await call("/api/overview")).json<Overview>();
    expect(body.period).toEqual({ key: "2026-11", start: "2026-10-23", end: "2026-11-24" });
  });

  it.each(["2026-13", "november"])("perioden %s ger 400", async (period) => {
    const res = await call(`/api/overview?period=${period}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
  });

  it("svarar 503 utan detaljer när databasen inte går att läsa", async () => {
    const broken = { prepare: () => { throw new Error("D1 nere"); } } as unknown as D1Database;
    const res = await call("/api/overview", { DB: broken });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
  });

  it("andra metoder ger 405", async () => {
    const res = await call("/api/overview", {}, "POST");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });
});
