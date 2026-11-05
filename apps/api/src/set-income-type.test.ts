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

beforeAll(async () => {
  ({ db, dispose } = await migratedDb());
  key = await createTestKey("income-type-key");
  const { fetchImpl } = jwksFetch(key);
  guardDeps = {
    verifierFor: () => cachedVerifier({ issuer: ISSUER, audience: AUD, allowedEmails: [INVITED], appOrigin: ORIGIN }, fetchImpl),
    logger: captureLogs().logger,
  };
});
afterAll(async () => {
  await dispose();
});

/** Påhittade transaktioner (KK-13). Skandia skickar ingen motpart, så namnet står i description. */
beforeEach(async () => {
  const tx = (id: string, amount: number, description: string, type: string | null, source: string, status = "booked") =>
    db
      .prepare(
        `INSERT INTO transactions (id, account_id, fingerprint, status, last_seen_at, transaction_date, amount_minor, description, income_type, income_source)
         VALUES (?, 'a1', 'fp', ?, '2026-11-02', '2026-11-02', ?, ?, ?, ?)`,
      )
      .bind(id, status, amount, description, type, source);
  await db.batch([
    db.prepare(`DELETE FROM bank_connections`),
    db.prepare(`DELETE FROM category_rules WHERE source = 'learned'`),
    db.prepare(`INSERT INTO bank_connections (id, provider, status) VALUES ('c1', 'enablebanking', 'active')`),
    db.prepare(`INSERT INTO accounts (id, connection_id, display_name, type) VALUES ('a1', 'c1', 'Privatkonto', 'checking')`),
    tx("okt", 3_300_000, "EXEMPEL AB", "other", "none"),
    tx("nov", 3_300_000, "EXEMPEL AB, STOCKHOLM", "other", "none"),
    tx("manuell", 3_300_000, "EXEMPEL AB", "parental_benefit", "manual"),
    tx("swish", 20_000, "Swish från Anna", "other", "none"),
    tx("utgift", -4_500, "EXEMPEL AB", null, "none"),
    tx("bort", 3_300_000, "EXEMPEL AB", null, "none", "removed"),
  ]);
});

async function patch(id: string, body: unknown, env: Partial<Env> = {}) {
  const context: RouteContext = {
    waitUntil: () => undefined,
    sync: { logger: captureLogs().logger, clock: fixedClock("2026-11-04T10:00:00.000Z"), newId: () => `ir-${String(++seq)}`, providerFor: () => null },
    connectorFor: () => null,
  };
  const headers = new Headers({ "cf-access-jwt-assertion": await signToken(key), "content-type": "application/json", origin: ORIGIN, "x-kronkoll": "1" });
  const init = { method: "PATCH", headers, body: typeof body === "string" ? body : JSON.stringify(body) };
  return handle(new Request(`${ORIGIN}/api/transactions/${id}`, init), configuredEnv({ DB: db, ...env }), guardDeps, context);
}

const types = async () =>
  (await db.prepare(`SELECT id, income_type AS t, income_source AS s FROM transactions ORDER BY id`).all<{ id: string; t: string | null; s: string }>()).results;

describe("ändra inkomsttyp (KK-22-A)", () => {
  it("blir manuell, lär en regel på namnet och klassar arbetsgivarens övriga löner, men inte manuella", async () => {
    const res = await patch("okt", { income_type: "salary" });
    expect(res.status).toBe(200);
    const body = await res.json<{ rule: { id: string } }>();
    expect(body).toEqual({
      transaction: { id: "okt", income_type: "salary", income_source: "manual" },
      rule: { id: body.rule.id, match: "counterparty_prefix", pattern: "EXEMPEL AB", income_type: "salary" },
      updated: 1,
    });
    expect(await types()).toEqual([
      { id: "bort", t: null, s: "none" },
      { id: "manuell", t: "parental_benefit", s: "manual" },
      { id: "nov", t: "salary", s: "learned" },
      { id: "okt", t: "salary", s: "manual" },
      { id: "swish", t: "other", s: "none" },
      { id: "utgift", t: null, s: "none" },
    ]);
    // En ny ändring för samma namn uppdaterar regeln i stället för att skapa en ny.
    await patch("nov", { income_type: "other" });
    const rules = await db.prepare(`SELECT pattern, income_type AS t FROM category_rules WHERE source = 'learned'`).all();
    expect(rules.results).toEqual([{ pattern: "EXEMPEL AB", t: "other" }]);
  });

  it("en kategoriändring går fortfarande till kategorin", async () => {
    expect(await (await patch("swish", { category_id: "finns-inte", income_type: "salary" })).json()).toEqual({ error: "unknown_category" });
  });

  it("vägrar fel typ, utbetalningar och transaktioner som inte finns", async () => {
    for (const body of [{ income_type: "bonus" }, { income_type: null }, { income_type: 1 }]) expect((await patch("okt", body)).status).toBe(400);
    expect(await (await patch("utgift", { income_type: "salary" })).json()).toEqual({ error: "not_income" });
    expect((await patch("bort", { income_type: "salary" })).status).toBe(404);
    expect((await patch("saknas", { income_type: "salary" })).status).toBe(404);
  });

  it("svarar 503 när databasen inte svarar", async () => {
    const broken = { DB: { prepare: () => { throw new Error("nere"); } } as unknown as D1Database };
    expect((await patch("okt", { income_type: "salary" }, broken)).status).toBe(503);
  });
});
