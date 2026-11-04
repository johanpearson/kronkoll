import type { D1Database } from "@cloudflare/workers-types";
import { accountRepository, connectionRepository, deriveKeys } from "@kronkoll/adapter-d1";
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
let seq = 0;

const kr = (amount: number) => amount * 100;

beforeAll(async () => {
  ({ db, dispose } = await migratedDb());
  key = await createTestKey("goals-key");
  const { fetchImpl } = jwksFetch(key);
  guardDeps = {
    verifierFor: () => cachedVerifier({ issuer: ISSUER, audience: AUD, allowedEmails: [INVITED], appOrigin: ORIGIN }, fetchImpl),
    logger: captureLogs().logger,
  };
});
afterAll(async () => {
  await dispose();
});

/** Ett påhittat sparkonto med 74 000 kr och 3 000 kr in i månaden de senaste tre månaderna (KK-13). */
beforeEach(async () => {
  await db.batch([db.prepare(`DELETE FROM savings_goals`), db.prepare(`DELETE FROM bank_connections`)]);
  const keys = await deriveKeys(randomSecret());
  await connectionRepository(db, keys).create({ id: "c1", provider: "enablebanking", aspspName: "Exempelbanken" });
  await accountRepository(db, keys).upsertFromBank(
    { connectionId: "c1", providerUid: "u1", iban: null, name: "Sparkonto", type: "savings", balanceMinor: kr(74000) },
    () => "acc_spar",
  );
  await db.batch(
    ["2026-08-25", "2026-09-25", "2026-10-25", "2026-07-25"].map((date, i) =>
      db
        .prepare(
          `INSERT INTO transactions (id, account_id, fingerprint, status, last_seen_at, transaction_date, booking_date, amount_minor)
           VALUES (?, 'acc_spar', 'fp', 'booked', ?, ?, ?, ?)`,
        )
        .bind(`t${String(i)}`, date, date, date, kr(3000)),
    ),
  );
});

async function call(method: string, path: string, body?: unknown, env: Partial<Env> = {}) {
  const context: RouteContext = {
    waitUntil: () => undefined,
    sync: { logger: captureLogs().logger, clock: fixedClock("2026-11-04T10:00:00.000Z"), newId: () => `g${String(++seq)}`, providerFor: () => null },
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

const JAPAN = { name: "Resa till Japan", target_minor: kr(60000), target_date: "2027-08-31", source: { type: "manual", initial_minor: kr(11900) } };

async function create(body: unknown) {
  const res = await call("POST", "/api/goals", body);
  return { status: res.status, body: await res.json<Record<string, unknown>>() };
}

describe("sparmål med prognos (KK-21)", () => {
  it("ett manuellt mål med 21 500 kr sparat och 3 200 kr/mån når 60 000 kr i dec. 2027, 4 mån efter måldatum (KK-21-A)", async () => {
    const { status, body } = await create(JAPAN);
    expect(status).toBe(201);
    const id = String(body["id"]);
    for (const [date, amount] of [["2026-08-30", 3200], ["2026-09-27", 3400], ["2026-10-28", 3000]] as const) {
      expect((await call("POST", `/api/goals/${id}/contributions`, { date, amount_minor: kr(amount) })).status).toBe(201);
    }
    const goal = await (await call("GET", `/api/goals/${id}`)).json();
    expect(goal).toEqual({
      id,
      name: "Resa till Japan",
      target_minor: kr(60000),
      target_date: "2027-08-31",
      source: "manual",
      account_id: null,
      account_missing: false,
      saved_minor: kr(21500),
      monthly_rate_minor: kr(3200),
      forecast: { kind: "eta", remaining_minor: kr(38500), months_left: 13, reach_period: "2027-12", on_track: false, months_late: 4, required_monthly_minor: 427778 },
      contributions: [
        { date: "2026-10-28", amount_minor: kr(3000) },
        { date: "2026-09-27", amount_minor: kr(3400) },
        { date: "2026-08-30", amount_minor: kr(3200) },
      ],
    });
    expect(await (await call("GET", "/api/goals")).json()).toEqual({ items: [goal] });
  });

  it("utan avsättningar nås målet inte i nuvarande takt, men vad som krävs visas (KK-21-B)", async () => {
    const { body } = await create({ ...JAPAN, target_date: "2027-03-31", source: { type: "manual" } });
    expect(body["forecast"]).toEqual({ kind: "never", remaining_minor: kr(60000), required_monthly_minor: kr(15000) });
    expect(body["saved_minor"]).toBe(0);
  });

  it("ett kopplat konto räknar saldot som sparat och insättningarna de senaste 3 månaderna som takt", async () => {
    const { status, body } = await create({ name: "Buffert", target_minor: kr(100000), source: { type: "account", account_id: "acc_spar" } });
    expect(status).toBe(201);
    expect(body).toMatchObject({
      source: "account",
      account_id: "acc_spar",
      account_missing: false,
      saved_minor: kr(74000),
      monthly_rate_minor: kr(3000),
      forecast: { kind: "eta", months_left: 9, reach_period: "2027-08", on_track: null, months_late: null, required_monthly_minor: null },
      contributions: [],
    });
  });

  it("ett mål som redan är nått, och ett mål vars konto har försvunnit", async () => {
    expect((await create({ ...JAPAN, target_minor: kr(11900) })).body["forecast"]).toEqual({ kind: "reached", remaining_minor: 0 });
    const { body } = await create({ name: "Buffert", target_minor: kr(100000), source: { type: "account", account_id: "acc_spar" } });
    await db.prepare(`DELETE FROM bank_connections`).run();
    expect(await (await call("GET", `/api/goals/${String(body["id"])}`)).json()).toMatchObject({ account_id: null, account_missing: true, saved_minor: 0, monthly_rate_minor: 0 });
  });
});

describe("ogiltiga anrop", () => {
  it("felaktiga mål ger 400 och sparas inte", async () => {
    const bad: unknown[] = [
      "inte json",
      null,
      { ...JAPAN, name: " " },
      { ...JAPAN, name: "x".repeat(61) },
      { ...JAPAN, target_minor: 0 },
      { ...JAPAN, target_minor: 1.5 },
      { ...JAPAN, target_date: "2027-02-30" },
      { ...JAPAN, target_date: "31 aug" },
      { ...JAPAN, source: null },
      { ...JAPAN, source: { type: "manual", initial_minor: -1 } },
      { ...JAPAN, source: { type: "account" } },
      { ...JAPAN, source: { type: "lån" } },
    ];
    for (const body of bad) expect((await call("POST", "/api/goals", body)).status, JSON.stringify(body)).toBe(400);
    expect(await (await call("GET", "/api/goals")).json()).toEqual({ items: [] });
  });

  it("ett måldatum i dag eller tidigare ger 422, och ett okänt konto 400", async () => {
    for (const target_date of ["2026-11-04", "2026-01-01"]) {
      expect(await create({ ...JAPAN, target_date })).toEqual({ status: 422, body: { error: "target_date_in_past" } });
    }
    expect(await create({ ...JAPAN, source: { type: "account", account_id: "saknas" } })).toEqual({ status: 400, body: { error: "unknown_account" } });
  });

  it("avsättningar: okänt mål 404, kontomål 409, felaktigt belopp eller datum i framtiden 400", async () => {
    expect((await call("POST", "/api/goals/saknas/contributions", { amount_minor: 100 })).status).toBe(404);
    const account = await create({ name: "Buffert", target_minor: kr(100000), source: { type: "account", account_id: "acc_spar" } });
    expect((await call("POST", `/api/goals/${String(account.body["id"])}/contributions`, { amount_minor: 100 })).status).toBe(409);
    const id = String((await create(JAPAN)).body["id"]);
    for (const body of [{ amount_minor: 0 }, { amount_minor: 1.5 }, { amount_minor: 100, date: "2026-11-05" }, { amount_minor: 100, date: "i går" }, "x"]) {
      expect((await call("POST", `/api/goals/${id}/contributions`, body)).status, JSON.stringify(body)).toBe(400);
    }
    const res = await call("POST", `/api/goals/${id}/contributions`, { amount_minor: kr(-500) });
    expect(await res.json()).toMatchObject({ saved_minor: kr(11400), contributions: [{ date: "2026-11-04", amount_minor: kr(-500) }] });
  });

  it("okänt mål ger 404, fel metod 405 och en databas som inte svarar 503", async () => {
    expect((await call("GET", "/api/goals/saknas")).status).toBe(404);
    expect((await call("DELETE", "/api/goals")).headers.get("allow")).toBe("GET, POST");
    expect((await call("PUT", "/api/goals/g1")).headers.get("allow")).toBe("GET");
    expect((await call("GET", "/api/goals/g1/contributions")).headers.get("allow")).toBe("POST");
    const broken = { prepare: () => { throw new Error("nere"); }, batch: () => { throw new Error("nere"); } } as unknown as D1Database;
    expect((await call("GET", "/api/goals", undefined, { DB: broken })).status).toBe(503);
    expect((await call("GET", "/api/goals/g1", undefined, { DB: broken })).status).toBe(503);
    expect((await call("POST", "/api/goals", JAPAN, { DB: broken })).status).toBe(503);
    expect((await call("POST", "/api/goals/g1/contributions", { amount_minor: 100 }, { DB: broken })).status).toBe(503);
  });
});
