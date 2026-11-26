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
  key = await createTestKey("categories-reset-key");
  const { fetchImpl } = jwksFetch(key);
  guardDeps = {
    verifierFor: () => cachedVerifier({ issuer: ISSUER, audience: AUD, allowedEmails: [INVITED], appOrigin: ORIGIN }, fetchImpl),
    logger: captureLogs().logger,
  };
});
afterAll(async () => {
  await dispose();
});

async function call(method = "POST", path = "/api/categories/reset", body?: unknown, env: Partial<Env> = {}) {
  const context: RouteContext = {
    waitUntil: () => undefined,
    sync: { logger: captureLogs().logger, clock: fixedClock("2026-11-15T10:00:00.000Z"), newId: () => `ny-${String(++seq)}`, providerFor: () => null },
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

const broken = { prepare: () => { throw new Error("D1 nere"); } } as unknown as D1Database;
const count = async (sql: string) => (await db.prepare(sql).first<{ n: number }>())?.n ?? -1;

/** Påhittade transaktioner (KK-13): en kategoriserad, en uppdelad, en manuell och en okategoriserad, plus en budget och en egen regel. */
beforeEach(async () => {
  // Testerna rensar kategorierna, så mallen sätts tillbaka först (en rensning med mallen är samma sak som från början).
  await call("POST", "/api/categories/reset", { confirm: true, restore_template: true });
  await db.batch([
    db.prepare(`DELETE FROM bank_connections`),
    db.prepare(`DELETE FROM category_rules WHERE source = 'learned'`),
    db.prepare(`DELETE FROM budget_lines`),
    db.prepare(`INSERT INTO bank_connections (id, provider, status) VALUES ('c1', 'enablebanking', 'active')`),
    db.prepare(`INSERT INTO accounts (id, connection_id, display_name, type) VALUES ('a1', 'c1', 'Privatkonto', 'checking')`),
    ...[
      ["t1", "mat-livsmedel", "template"],
      ["t2", "hushall-forbrukning", "manual"],
      ["t3", null, "none"],
      ["t4", "mat-livsmedel", "learned"],
    ].map(([id, category, source]) =>
      db
        .prepare(`INSERT INTO transactions (id, account_id, fingerprint, status, last_seen_at, transaction_date, amount_minor, category_id, category_source) VALUES (?, 'a1', 'fp', 'booked', '2026-11-02', '2026-11-02', -10000, ?, ?)`)
        .bind(id, category, source),
    ),
    db.prepare(`INSERT INTO transaction_splits (id, transaction_id, category_id, amount_minor) VALUES ('s1', 't4', 'mat-livsmedel', -6000), ('s2', 't4', 'hushall-forbrukning', -4000)`),
    db.prepare(`INSERT INTO budget_lines (period, category_id, amount_minor) VALUES ('2026-11', 'mat', 600000)`),
    db.prepare(`INSERT INTO category_rules (id, match, pattern, category_id, source) VALUES ('egen', 'counterparty_prefix', 'IKEA', 'hushall-forbrukning', 'learned')`),
  ]);
});

describe("POST /api/categories/reset (KK-48)", () => {
  it("förhandsvisar hur mycket som berörs utan att ändra något (KK-48-A)", async () => {
    const res = await call("POST", "/api/categories/reset", { preview: true });
    expect(res.status).toBe(200);
    const summary = await res.json<{ categories: number; rules: number; transactions: number; splits: number; budget_lines: number }>();
    expect(summary).toMatchObject({ transactions: 3, splits: 2, budget_lines: 1 });
    expect(summary.categories).toBeGreaterThan(30);
    // Mallens regler och den egna: alla som sätter en kategori.
    expect(summary.rules).toBe(await count(`SELECT count(*) AS n FROM category_rules WHERE action = 'categorize' AND category_id IS NOT NULL`));
    expect(await count(`SELECT count(*) AS n FROM categories`)).toBe(summary.categories);
    expect(await count(`SELECT count(*) AS n FROM transactions WHERE category_id IS NOT NULL`)).toBe(3);
  });

  it("rensar alla kategorier, regler, uppdelningar och budgetrader men raderar inga transaktioner (KK-48-B)", async () => {
    await db.prepare(`INSERT INTO category_rules (id, match, pattern, category_id, income_type, source) VALUES ('inkomst-egen', 'description_contains', 'BONUS', NULL, 'salary', 'learned')`).run();
    await db.prepare(`INSERT INTO category_rules (id, match, pattern, category_id, source, action) VALUES ('exkl', 'counterparty_prefix', 'PANTEN', NULL, 'learned', 'exclude')`).run();
    const res = await call("POST", "/api/categories/reset", { confirm: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reset: true, restored_template: false });
    expect(await count(`SELECT count(*) AS n FROM categories`)).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM transaction_splits`)).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM budget_lines`)).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM transactions`)).toBe(4);
    expect(await count(`SELECT count(*) AS n FROM transactions WHERE category_id IS NOT NULL OR category_source <> 'none'`)).toBe(0);
    // Regler som inte sätter en kategori ligger kvar.
    expect(await count(`SELECT count(*) AS n FROM category_rules WHERE action = 'categorize' AND category_id IS NOT NULL`)).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM category_rules WHERE id IN ('inkomst-egen', 'exkl')`)).toBe(2);
    expect((await (await call("GET", "/api/categories")).json<{ items: unknown[] }>()).items).toEqual([]);
    // En ny kategori går att lägga till från början.
    const created = await call("POST", "/api/categories", { parent_id: null, name: "Barn" });
    expect(created.status).toBe(201);
  });

  it("med restore_template sätts mallens kategorier och regler tillbaka, och egna regler är borta", async () => {
    const res = await call("POST", "/api/categories/reset", { confirm: true, restore_template: true });
    expect(await res.json()).toEqual({ reset: true, restored_template: true });
    const { items } = await (await call("GET", "/api/categories")).json<{ items: { id: string; parent_id: string | null }[] }>();
    expect(items.some((c) => c.id === "mat" && c.parent_id === null)).toBe(true);
    expect(items.some((c) => c.id === "mat-livsmedel" && c.parent_id === "mat")).toBe(true);
    expect(await count(`SELECT count(*) AS n FROM category_rules WHERE id = 'mall-ica' AND category_id = 'mat-livsmedel'`)).toBe(1);
    expect(await count(`SELECT count(*) AS n FROM category_rules WHERE id = 'egen'`)).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM transactions WHERE category_id IS NOT NULL`)).toBe(0);
  });

  it("ett fel ändrar ingenting", async () => {
    await expect(db.batch([db.prepare(`DELETE FROM categories`)])).rejects.toThrow();
    expect(await count(`SELECT count(*) AS n FROM transactions WHERE category_id IS NOT NULL`)).toBe(3);
    expect(await count(`SELECT count(*) AS n FROM categories`)).toBeGreaterThan(30);
  });

  it.each([
    ["ingen åtgärd", {}],
    ["både förhandsvisning och bekräftelse", { preview: true, confirm: true }],
    ["en bekräftelse som inte är sant eller falskt", { confirm: "ja" }],
    ["restore_template som inte är sant eller falskt", { confirm: true, restore_template: "ja" }],
    ["kroppen är inte ett objekt", "[]"],
  ])("%s ger 400 och ändrar ingenting", async (_, input) => {
    const res = await call("POST", "/api/categories/reset", input);
    expect(res.status).toBe(400);
    expect(await count(`SELECT count(*) AS n FROM transactions WHERE category_id IS NOT NULL`)).toBe(3);
  });

  it("svarar 405 på fel metod och 503 utan detaljer när databasen inte går att nå", async () => {
    const wrong = await call("GET", "/api/categories/reset");
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toBe("POST");
    for (const input of [{ preview: true }, { confirm: true }]) {
      const res = await call("POST", "/api/categories/reset", input, { DB: broken });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "unavailable" });
    }
  });
});
