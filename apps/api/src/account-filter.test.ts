import type { D1Database } from "@cloudflare/workers-types";
import { accountRepository, connectionRepository, deriveKeys, settingsRepository } from "@kronkoll/adapter-d1";
import { migratedDb, randomSecret } from "@kronkoll/adapter-d1/test-support";
import { fixedClock } from "@kronkoll/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cachedVerifier, type GuardDeps } from "./access.ts";
import { MAX_FILTER_ACCOUNTS, readAccountFilter } from "./account-filter.ts";
import { handle, type RouteContext } from "./index.ts";
import { AUD, INVITED, ISSUER, ORIGIN, captureLogs, configuredEnv, createTestKey, jwksFetch, signToken, type TestKey } from "./test-support.ts";

let db: D1Database;
let dispose: () => Promise<void>;
let key: TestKey;
let guardDeps: GuardDeps;

/** Påhittade konton och utgifter (KK-13): 20 kr på Gemensamt och 70 kr på Privat, i november. */
beforeAll(async () => {
  ({ db, dispose } = await migratedDb());
  const keys = await deriveKeys(randomSecret());
  key = await createTestKey("account-filter-key");
  const { fetchImpl } = jwksFetch(key);
  guardDeps = {
    verifierFor: () => cachedVerifier({ issuer: ISSUER, audience: AUD, allowedEmails: [INVITED], appOrigin: ORIGIN }, fetchImpl),
    logger: captureLogs().logger,
  };
  await connectionRepository(db, keys).create({ id: "c1", provider: "enablebanking", aspspName: "Skandia" });
  const accounts = accountRepository(db, keys);
  await accounts.upsertFromBank({ connectionId: "c1", providerUid: "u1", iban: null, name: "Gemensamt", type: "checking", balanceMinor: 0 }, () => "acc_a");
  await accounts.upsertFromBank({ connectionId: "c1", providerUid: "u2", iban: null, name: "Privat", type: "checking", balanceMinor: 0 }, () => "acc_b");
  await settingsRepository(db).setBudgetPeriodStartDay(1);
  await db.batch(
    [["a1", "acc_a", -2000], ["b1", "acc_b", -7000]].map(([id, account, amount]) =>
      db
        .prepare(
          `INSERT INTO transactions (id, account_id, fingerprint, status, last_seen_at, transaction_date, booking_date, amount_minor, counterparty, counterparty_norm, category_source, is_internal_transfer)
           VALUES (?, ?, 'fp', 'booked', '2026-11-05', '2026-11-05', '2026-11-05', ?, 'Butik', 'BUTIK', 'none', 0)`,
        )
        .bind(id, account, amount),
    ),
  );
});
afterAll(async () => {
  await dispose();
});

async function get(path: string) {
  const context: RouteContext = {
    waitUntil: () => undefined,
    sync: { logger: captureLogs().logger, clock: fixedClock("2026-11-15T10:00:00.000Z"), newId: () => "x", providerFor: () => null },
    connectorFor: () => null,
  };
  const headers = new Headers({ "cf-access-jwt-assertion": await signToken(key) });
  return handle(new Request(`${ORIGIN}${path}`, { headers }), configuredEnv({ DB: db }), guardDeps, context);
}

describe("readAccountFilter", () => {
  const read = (query: string) => readAccountFilter(new URL(`https://x/api?${query}`));

  it("utan konto finns inget filter, och med konton kommer de i ordning utan dubbletter", () => {
    expect(read("period=2026-11")).toBeUndefined();
    expect(read("account=acc_a&account=acc_b&account=acc_a")).toEqual(["acc_a", "acc_b"]);
  });

  it.each([
    ["ett tomt id", "account="],
    ["ett för långt id", `account=${"x".repeat(65)}`],
    ["för många konton", Array.from({ length: MAX_FILTER_ACCOUNTS + 1 }, (_, i) => `account=a${String(i)}`).join("&")],
  ])("%s är ogiltigt", (_, query) => {
    expect(read(query)).toBeNull();
  });

  it("tillåter högst MAX_FILTER_ACCOUNTS konton", () => {
    expect(read(Array.from({ length: MAX_FILTER_ACCOUNTS }, (_, i) => `account=a${String(i)}`).join("&"))).toHaveLength(MAX_FILTER_ACCOUNTS);
  });
});

describe("kontofilter i API:et (KK-41-C)", () => {
  it("GET /api/transactions", async () => {
    const ids = async (q: string) => (await (await get(`/api/transactions?period=2026-11${q}`)).json<{ items: { id: string }[] }>()).items.map((i) => i.id);
    expect((await ids("")).sort()).toEqual(["a1", "b1"]);
    expect(await ids("&account=acc_b")).toEqual(["b1"]);
    expect((await ids("&account=acc_a&account=acc_b")).sort()).toEqual(["a1", "b1"]);
  });

  it("GET /api/budgets/{period}: utfallet följer kontona", async () => {
    const actual = async (q: string) => (await (await get(`/api/budgets/2026-11${q}`)).json<{ total_actual_minor: number }>()).total_actual_minor;
    expect(await actual("")).toBe(9000);
    expect(await actual("?account=acc_a")).toBe(2000);
    expect(await actual("?account=acc_b")).toBe(7000);
  });

  it("GET /api/insights: största utgifterna följer kontona", async () => {
    const top = async (q: string) => (await (await get(`/api/insights?period=2026-11${q}`)).json<{ top_expenses: { id: string }[] }>()).top_expenses.map((t) => t.id);
    expect((await top("")).sort()).toEqual(["a1", "b1"]);
    expect(await top("&account=acc_a")).toEqual(["a1"]);
  });

  it.each(["/api/transactions?account=", "/api/budgets/2026-11?account=", "/api/insights?account="])("%s ger 400", async (path) => {
    const res = await get(path);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
  });
});
