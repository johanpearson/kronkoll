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

beforeAll(async () => {
  ({ db, dispose } = await migratedDb());
  const keys = await deriveKeys(randomSecret());
  key = await createTestKey("rules-key");
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

/** Påhittade kortköp (KK-13) i Skandias form: ingen motpart, butiken i meddelandet. */
beforeEach(async () => {
  await db.batch([
    db.prepare(`DELETE FROM transactions`),
    db.prepare(`DELETE FROM category_rules WHERE source = 'learned'`),
    db.prepare(`UPDATE categories SET archived = 0`),
    // Ett test ändrar mallregeln för ICA. Återställ den så att testerna inte beror på ordningen.
    db.prepare(`UPDATE category_rules SET pattern = 'ICA', category_id = 'mat-livsmedel' WHERE id = 'mall-ica'`),
  ]);
  const rows: [string, string, string | null, string][] = [
    ["k1", "IKEA KARLSTAD, KARLSTAD", null, "none"],
    ["k2", "IKEA KUNGENS KURVA, STOCKHOLM", null, "none"],
    ["k3", "IKEA BARKARBY, JARFALLA", "fritid-hobby", "manual"],
    ["i1", "ICA NARA SOFO, STOCKHOLM", "mat-livsmedel", "template"],
  ];
  await db.batch(
    rows.map(([id, description, category, source]) =>
      db
        .prepare(
          `INSERT INTO transactions (id, account_id, fingerprint, status, last_seen_at, transaction_date, amount_minor, counterparty, counterparty_norm, description, category_id, category_source)
           VALUES (?, 'acc_1', 'fp', 'booked', '2026-11-02', '2026-11-02', -100, '', '', ?, ?, ?)`,
        )
        .bind(id, description, category, source),
    ),
  );
});

async function call(method: string, path = "/api/rules", body?: unknown, env: Partial<Env> = {}) {
  const context: RouteContext = {
    waitUntil: () => undefined,
    sync: { logger: captureLogs().logger, clock: fixedClock("2026-11-15T10:00:00.000Z"), newId: () => `r-${String(++seq)}`, providerFor: () => null },
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

type Item = { id: string; pattern: string; category_id: string; source: string; hits: number; category_archived: boolean };
const items = async () => (await (await call("GET")).json<{ items: Item[] }>()).items;
const broken = { prepare: () => { throw new Error("D1 nere"); } } as unknown as D1Database;

describe("GET /api/rules (KK-18)", () => {
  it("listar reglerna sorterade på mönster, med träffar och om kategorin är arkiverad", async () => {
    await db.prepare(`UPDATE categories SET archived = 1 WHERE id = 'abonnemang-streaming'`).run();
    const all = await items();
    expect(all.find((r) => r.id === "mall-ica")).toEqual({ id: "mall-ica", match: "counterparty_prefix", pattern: "ICA", category_id: "mat-livsmedel", source: "template", hits: 1, category_archived: false });
    expect(all.find((r) => r.id === "mall-spotify")).toMatchObject({ hits: 0, category_archived: true });
    expect(all.map((r) => r.pattern)).toEqual([...all.map((r) => r.pattern)].sort((a, b) => a.localeCompare(b, "sv")));
  });

  it("svarar 503 utan detaljer när databasen inte går att läsa, och andra metoder ger 405", async () => {
    expect((await call("GET", undefined, undefined, { DB: broken })).status).toBe(503);
    const res = await call("PUT", undefined, {});
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, POST");
  });
});

describe("POST /api/rules (KK-18-B)", () => {
  it("lägger till \"allt som börjar med\" ett normaliserat mönster och säger vad den skulle ändra bakåt", async () => {
    const res = await call("POST", undefined, { pattern: " ikea ", category_id: "hushall-forbrukning" });
    expect(res.status).toBe(201);
    // k1 och k2 får kategorin om den appliceras; k3 är manuellt vald och ändras aldrig.
    expect(await res.json()).toEqual({
      rule: { id: "r-1", match: "counterparty_prefix", pattern: "IKEA", category_id: "hushall-forbrukning", source: "learned" },
      retroactive_candidates: 2,
      protected_manual: 1,
    });
    expect((await items()).find((r) => r.pattern === "IKEA")).toMatchObject({ hits: 3 });
  });

  it("samma mönster igen byter kategori på den befintliga regeln", async () => {
    const first = await (await call("POST", undefined, { pattern: "IKEA", category_id: "hushall-forbrukning" })).json<{ rule: { id: string } }>();
    const res = await call("POST", undefined, { pattern: "ikea", category_id: "fritid-hobby" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ rule: { id: first.rule.id, category_id: "fritid-hobby" } });
    expect((await items()).filter((r) => r.pattern === "IKEA")).toHaveLength(1);
  });

  it.each([
    ["en arkiverad kategori", { pattern: "IKEA", category_id: "boende" }, "unknown_category", true],
    ["en okänd kategori", { pattern: "IKEA", category_id: "finns-inte" }, "unknown_category", false],
    ["ett tomt mönster", { pattern: " 123 ", category_id: "boende" }, "invalid_request", false],
    ["ett för långt mönster", { pattern: "x".repeat(61), category_id: "boende" }, "invalid_request", false],
    ["en radbrytning", { pattern: "IK\nEA", category_id: "boende" }, "invalid_request", false],
    ["ingen kategori", { pattern: "IKEA" }, "invalid_request", false],
    ["inte JSON", "{", "invalid_request", false],
  ])("%s ger 400", async (_, body, error, archive) => {
    if (archive) await db.prepare(`UPDATE categories SET archived = 1 WHERE id = 'boende'`).run();
    const res = await call("POST", undefined, body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error });
  });
});

describe("PATCH och DELETE /api/rules/{id} (KK-18)", () => {
  it("byter kategori på en mallregel och gör mönstret kortare", async () => {
    const res = await call("PATCH", "/api/rules/mall-ica", { pattern: "ica", category_id: "mat-restaurang-cafe" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ rule: { id: "mall-ica", pattern: "ICA", category_id: "mat-restaurang-cafe", source: "template" }, retroactive_candidates: 1 });
  });

  it.each([
    ["ingen ändring", {}, 400],
    ["ett tomt mönster", { pattern: "" }, 400],
    ["en kategori som inte är text", { category_id: 5 }, 400],
    ["en arkiverad kategori", { category_id: "noje" }, 400],
  ])("%s ger %i", async (_, body, status) => {
    await db.prepare(`UPDATE categories SET archived = 1 WHERE id = 'noje'`).run();
    expect((await call("PATCH", "/api/rules/mall-ica", body)).status).toBe(status);
  });

  it("tar bort en regel, och en regel som saknas ger 404", async () => {
    const { rule } = await (await call("POST", undefined, { pattern: "IKEA", category_id: "hushall-forbrukning" })).json<{ rule: { id: string } }>();
    expect((await call("DELETE", `/api/rules/${rule.id}`)).status).toBe(204);
    expect((await items()).some((r) => r.id === rule.id)).toBe(false);
    expect((await call("DELETE", `/api/rules/${rule.id}`)).status).toBe(404);
    expect((await call("PATCH", "/api/rules/finns-inte", { pattern: "X" })).status).toBe(404);
  });

  it("svarar 503 utan detaljer när databasen inte går att nå, och andra metoder ger 405", async () => {
    expect((await call("PATCH", "/api/rules/mall-ica", { pattern: "X" }, { DB: broken })).status).toBe(503);
    expect((await call("DELETE", "/api/rules/mall-ica", undefined, { DB: broken })).status).toBe(503);
    expect((await call("POST", undefined, { pattern: "X", category_id: "mat" }, { DB: broken })).status).toBe(503);
    const res = await call("GET", "/api/rules/mall-ica");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("PATCH, DELETE");
  });
});

describe("GET /api/rules/{id}/matches (KK-18-C)", () => {
  it("listar transaktionerna regeln gäller, med vad som händer med var och en", async () => {
    const { rule } = await (await call("POST", undefined, { pattern: "IKEA", category_id: "hushall-forbrukning" })).json<{ rule: { id: string } }>();
    const res = await call("GET", `/api/rules/${rule.id}/matches`);
    expect(res.status).toBe(200);
    const body = await res.json<{ total: number; change: number; unchanged: number; manual: number; items: { id: string; name: string; effect: string }[] }>();
    expect({ total: body.total, change: body.change, unchanged: body.unchanged, manual: body.manual }).toEqual({ total: 3, change: 2, unchanged: 0, manual: 1 });
    expect(body.items.find((i) => i.id === "k3")).toEqual({
      id: "k3",
      transaction_date: "2026-11-02",
      name: "IKEA BARKARBY, JARFALLA",
      amount_minor: -100,
      category_id: "fritid-hobby",
      effect: "manual",
    });
  });

  it("en regel som saknas ger 404, andra metoder 405 och en trasig databas 503", async () => {
    expect((await call("GET", "/api/rules/finns-inte/matches")).status).toBe(404);
    expect((await call("POST", "/api/rules/mall-ica/matches", {})).status).toBe(405);
    expect((await call("GET", "/api/rules/mall-ica/matches", undefined, { DB: broken })).status).toBe(503);
  });
});

describe("POST /api/rules/apply-all (KK-18-C)", () => {
  it("räknar först, applicerar sedan alla regler, och rör aldrig manuellt valda", async () => {
    await call("POST", undefined, { pattern: "IKEA", category_id: "hushall-forbrukning" });
    const preview = await call("POST", "/api/rules/apply-all", { preview: true });
    expect(await preview.json()).toEqual({ would_update: 2 });
    const category = async (id: string) => db.prepare(`SELECT category_id AS c FROM transactions WHERE id = ?`).bind(id).first();
    expect(await category("k1")).toEqual({ c: null });
    const res = await call("POST", "/api/rules/apply-all", {});
    expect(await res.json()).toEqual({ updated: 2 });
    expect(await category("k1")).toEqual({ c: "hushall-forbrukning" });
    expect(await category("k3")).toEqual({ c: "fritid-hobby" });
  });

  it("ogiltig begäran ger 400, andra metoder 405 och en trasig databas 503", async () => {
    expect((await call("POST", "/api/rules/apply-all", { preview: "ja" })).status).toBe(400);
    expect((await call("POST", "/api/rules/apply-all", "{")).status).toBe(400);
    expect((await call("GET", "/api/rules/apply-all")).status).toBe(405);
    expect((await call("POST", "/api/rules/apply-all", {}, { DB: broken })).status).toBe(503);
  });
});
