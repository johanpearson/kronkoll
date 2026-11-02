import type { D1Database } from "@cloudflare/workers-types";
import { accountRepository, connectionRepository, deriveKeys } from "@kronkoll/adapter-d1";
import { migratedDb, randomSecret } from "@kronkoll/adapter-d1/test-support";
import { fixedClock } from "@kronkoll/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cachedVerifier, type GuardDeps } from "./access.ts";
import { handle, type RouteContext } from "./index.ts";
import { AUD, INVITED, ISSUER, ORIGIN, captureLogs, configuredEnv, createTestKey, jwksFetch, signToken, type TestKey } from "./test-support.ts";

let db: D1Database;
let dispose: () => Promise<void>;
let key: TestKey;
let guardDeps: GuardDeps;

beforeAll(async () => {
  ({ db, dispose } = await migratedDb());
  const keys = await deriveKeys(randomSecret());
  key = await createTestKey("set-category-key");
  const { fetchImpl } = jwksFetch(key);
  guardDeps = {
    verifierFor: () => cachedVerifier({ issuer: ISSUER, audience: AUD, allowedEmails: [INVITED], appOrigin: ORIGIN }, fetchImpl),
    logger: captureLogs().logger,
  };
  await connectionRepository(db, keys).create({ id: "c1", provider: "enablebanking", aspspName: "Skandia" });
  await accountRepository(db, keys).upsertFromBank({ connectionId: "c1", providerUid: "u1", iban: null, name: "Privatkonto", type: "checking", balanceMinor: 0 }, () => "acc_1");
});
afterAll(async () => {
  await dispose();
});

/** Påhittade transaktioner (KK-13). */
beforeEach(async () => {
  await db.batch([db.prepare(`DELETE FROM transactions`), db.prepare(`DELETE FROM category_rules WHERE source = 'learned'`)]);
  const rows: [string, string, string, string | null, string][] = [
    ["t1", "ICA NARA SOFO", "booked", null, "none"],
    ["t2", "ICA NARA SOFO", "booked", "mat-livsmedel", "template"],
    ["t3", "ICA NARA SOFO", "booked", "barn-mat-blojor", "manual"],
    ["t4", "SL", "booked", null, "none"],
    ["t5", "ICA NARA SOFO", "removed", null, "none"],
  ];
  await db.batch(
    rows.map(([id, norm, status, category, source]) =>
      db
        .prepare(
          `INSERT INTO transactions (id, account_id, fingerprint, status, last_seen_at, transaction_date, amount_minor, counterparty, counterparty_norm, category_id, category_source)
           VALUES (?, 'acc_1', 'fp', ?, '2026-11-02', '2026-11-02', -100, ?, ?, ?, ?)`,
        )
        .bind(id, status, norm, norm, category, source),
    ),
  );
});

let seq = 0;
async function call(method: string, path: string, body?: unknown, init: { csrf?: boolean } = {}) {
  const context: RouteContext = {
    waitUntil: () => undefined,
    sync: { logger: captureLogs().logger, clock: fixedClock("2026-11-15T10:00:00.000Z"), newId: () => `r-${String(++seq)}`, providerFor: () => null },
    connectorFor: () => null,
  };
  const headers = new Headers({ "cf-access-jwt-assertion": await signToken(key), "content-type": "application/json" });
  if (init.csrf !== false) {
    headers.set("origin", ORIGIN);
    headers.set("x-kronkoll", "1");
  }
  const request = new Request(`${ORIGIN}${path}`, { method, headers, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
  return handle(request, configuredEnv({ DB: db }), guardDeps, context);
}

const category = async (id: string) => db.prepare(`SELECT category_id AS c, category_source AS s FROM transactions WHERE id = ?`).bind(id).first();

describe("PATCH /api/transactions/{id} (KK-18-B, KK-18-C)", () => {
  it("sätter en manuell kategori utan regel", async () => {
    const res = await call("PATCH", "/api/transactions/t1", { category_id: "hushall-forbrukning" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      transaction: { id: "t1", category_id: "hushall-forbrukning", category_source: "manual" },
      rule: null,
      retroactive_candidates: 0,
      protected_manual: 0,
    });
    expect(await category("t1")).toEqual({ c: "hushall-forbrukning", s: "manual" });
  });

  it("\"Gör alltid så\" lär in en regel på hela motparten och säger vad den skulle ändra bakåt, utan att ändra något än", async () => {
    const res = await call("PATCH", "/api/transactions/t1", { category_id: "hushall-forbrukning", learn_rule: true });
    const body = await res.json<{ rule: { id: string } }>();
    expect(body).toEqual({
      transaction: { id: "t1", category_id: "hushall-forbrukning", category_source: "manual" },
      rule: { id: body.rule.id, match: "counterparty_prefix", pattern: "ICA NARA SOFO", category_id: "hushall-forbrukning" },
      retroactive_candidates: 1,
      protected_manual: 1,
    });
    expect(await category("t2")).toEqual({ c: "mat-livsmedel", s: "template" });
  });

  it("samma motpart igen uppdaterar den inlärda regeln i stället för att skapa en ny", async () => {
    const first = await (await call("PATCH", "/api/transactions/t1", { category_id: "hushall-forbrukning", learn_rule: true })).json<{ rule: { id: string } }>();
    const second = await (await call("PATCH", "/api/transactions/t1", { category_id: "mat-restaurang-cafe", learn_rule: true })).json<{ rule: { id: string; category_id: string } }>();
    expect(second.rule).toMatchObject({ id: first.rule.id, category_id: "mat-restaurang-cafe" });
    const learned = await db.prepare(`SELECT count(*) AS n FROM category_rules WHERE source = 'learned'`).first<{ n: number }>();
    expect(learned?.n).toBe(1);
  });

  it.each([
    ["en kategori som inte finns", { category_id: "finns-inte" }, 400, "unknown_category"],
    ["ingen kategori", { learn_rule: true }, 400, "invalid_request"],
    ["learn_rule som inte är sant eller falskt", { category_id: "hushall-forbrukning", learn_rule: "ja" }, 400, "invalid_request"],
    ["inte JSON", "{", 400, "invalid_request"],
  ])("%s ger %i och ändrar ingenting", async (_, body, status, error) => {
    const res = await call("PATCH", "/api/transactions/t1", body);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error });
    expect(await category("t1")).toEqual({ c: null, s: "none" });
  });

  it.each(["/api/transactions/saknas", "/api/transactions/t5"])("%s (saknas eller borttagen) ger 404", async (path) => {
    const res = await call("PATCH", path, { category_id: "hushall-forbrukning" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("kräver CSRF-skydd (KK-29-B)", async () => {
    expect((await call("PATCH", "/api/transactions/t1", { category_id: "hushall-forbrukning" }, { csrf: false })).status).toBe(403);
    expect(await category("t1")).toEqual({ c: null, s: "none" });
  });

  it("andra metoder ger 405", async () => {
    const res = await call("GET", "/api/transactions/t1");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("PATCH");
  });
});

describe("POST /api/rules/{id}/apply (KK-18-C)", () => {
  it("applicerar regeln bakåt men rör aldrig manuella transaktioner", async () => {
    const { rule } = await (await call("PATCH", "/api/transactions/t1", { category_id: "hushall-forbrukning", learn_rule: true })).json<{ rule: { id: string } }>();
    const res = await call("POST", `/api/rules/${rule.id}/apply`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: 1, skipped_manual: 2 });
    expect(await category("t2")).toEqual({ c: "hushall-forbrukning", s: "learned" });
    expect(await category("t3")).toEqual({ c: "barn-mat-blojor", s: "manual" });
    expect(await category("t1")).toEqual({ c: "hushall-forbrukning", s: "manual" });
    expect(await category("t4")).toEqual({ c: null, s: "none" });
  });

  it("en regel som inte finns ger 404", async () => {
    const res = await call("POST", "/api/rules/saknas/apply");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("kräver CSRF-skydd och POST", async () => {
    expect((await call("POST", "/api/rules/mall-ica/apply", undefined, { csrf: false })).status).toBe(403);
    const res = await call("GET", "/api/rules/mall-ica/apply");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });
});
