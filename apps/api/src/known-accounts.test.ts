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
  key = await createTestKey("known-accounts-key");
  const { fetchImpl } = jwksFetch(key);
  guardDeps = {
    verifierFor: () => cachedVerifier({ issuer: ISSUER, audience: AUD, allowedEmails: [INVITED], appOrigin: ORIGIN }, fetchImpl),
    logger: captureLogs().logger,
  };
  await db.batch([
    db.prepare(`INSERT INTO bank_connections (id, provider, aspsp_name, status) VALUES ('c1', 'enablebanking', 'Skandia', 'active')`),
    db.prepare(`INSERT INTO accounts (id, connection_id, display_name, type) VALUES ('acc_1', 'c1', 'Privatkonto', 'checking')`),
  ]);
});
afterAll(async () => {
  await dispose();
});
beforeEach(async () => {
  // Påhittade betalningar (KK-13). SL-mallen träffar "sl", så att reglerna kan sätta en kategori igen.
  await db.batch([
    db.prepare(`DELETE FROM transactions`),
    db.prepare(`DELETE FROM known_accounts`),
    db.prepare(
      `INSERT INTO transactions (id, account_id, fingerprint, status, last_seen_at, transaction_date, booking_date, amount_minor, counterparty, counterparty_norm, description)
       VALUES ('bet', 'acc_1', 'fp', 'booked', '2026-11-02', '2026-11-02', '2026-11-02', -200000, '', '', 'Swish till Exempel B'),
              ('bet2', 'acc_1', 'fp', 'booked', '2026-11-04', '2026-11-04', '2026-11-04', -100000, '', '', 'Swish till Exempel B 2'),
              ('sl', 'acc_1', 'fp', 'booked', '2026-11-03', '2026-11-03', '2026-11-03', -3900, 'SL', 'SL', ''),
              ('borta', 'acc_1', 'fp', 'removed', '2026-11-03', '2026-11-03', NULL, -100, 'X', 'X', '')`,
    ),
  ]);
});

async function call(method: string, path: string, body?: unknown, env: Partial<Env> = {}) {
  const context: RouteContext = {
    waitUntil: () => undefined,
    sync: { logger: captureLogs().logger, clock: fixedClock("2026-11-15T10:00:00.000Z"), newId: () => "x", providerFor: () => null },
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

const A = { name: "<b>Konto A</b>", match_patterns: ["swish  till exempel b"], category_id: "boende-laneranta" };
const category = async (id: string) => db.prepare(`SELECT known_account_id AS ka, category_id AS c, category_source AS s FROM transactions WHERE id = ?`).bind(id).first();

describe("kända konton (KK-54-A)", () => {
  it("sparar ett konto, normaliserar texterna, kopplar om historiken och listar det", async () => {
    const res = await call("PUT", "/api/known-accounts/ka1", A);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "ka1", name: "<b>Konto A</b>", match_patterns: ["SWISH TILL EXEMPEL B"], category_id: "boende-laneranta", linked: 2 });
    expect(await category("bet")).toEqual({ ka: "ka1", c: "boende-laneranta", s: "learned" });
    expect(await category("sl")).toEqual({ ka: null, c: null, s: "none" });
    expect(await (await call("GET", "/api/known-accounts")).json()).toEqual({
      known_accounts: [{ id: "ka1", name: "<b>Konto A</b>", match_patterns: ["SWISH TILL EXEMPEL B"], category_id: "boende-laneranta" }],
    });
  });

  it("ändrar ett konto med 200, och nya texter gäller bakåt", async () => {
    await call("PUT", "/api/known-accounts/ka1", A);
    const res = await call("PUT", "/api/known-accounts/ka1", { ...A, match_patterns: ["SL"] });
    expect(res.status).toBe(200);
    expect(await category("bet")).toEqual({ ka: null, c: null, s: "none" });
    expect(await category("sl")).toMatchObject({ ka: "ka1", c: "boende-laneranta" });
  });

  it("avvisar fel indata: namn, texter, kategori och okänd kategori", async () => {
    const bad = [
      "inte json",
      [],
      { ...A, name: "" },
      { ...A, name: "x".repeat(61) },
      { ...A, match_patterns: [] },
      { ...A, match_patterns: ["  "] },
      { ...A, match_patterns: "SL" },
      { ...A, match_patterns: Array.from({ length: 11 }, (_, i) => `T${String(i)}`) },
      { ...A, match_patterns: ["x".repeat(61)] },
      { ...A, category_id: undefined },
      { ...A, category_id: "" },
      { ...A, category_id: "finns-inte" },
    ];
    for (const body of bad) expect((await call("PUT", "/api/known-accounts/ka1", body)).status, JSON.stringify(body)).toBe(400);
  });

  it("tar bort ett konto: automatiska kopplingar släpper sin kategori, och ett okänt konto ger 404", async () => {
    await call("PUT", "/api/known-accounts/ka1", A);
    expect((await call("DELETE", "/api/known-accounts/ka1")).status).toBe(204);
    expect(await category("bet")).toEqual({ ka: null, c: null, s: "none" });
    expect((await call("DELETE", "/api/known-accounts/ka1")).status).toBe(404);
  });

  it("förhandsvisar antalet träffar utan att spara, och räknar om ett befintligt konto med nya texter", async () => {
    const count = async (body: unknown) => (await (await call("POST", "/api/known-accounts/preview", body)).json<{ count: number }>()).count;
    expect(await count({ match_patterns: ["swish till"] })).toBe(2);
    expect(await count({ match_patterns: ["swish till exempel b 2"] })).toBe(1);
    expect(await count({ match_patterns: [] })).toBe(0);
    expect(await (await call("GET", "/api/known-accounts")).json()).toEqual({ known_accounts: [] });
    await call("PUT", "/api/known-accounts/ka1", A);
    expect(await count({ id: "ka1", match_patterns: ["SL"] })).toBe(1);
    expect(await count({ match_patterns: ["swish"] })).toBe(0);
    for (const body of ["inte json", {}, { match_patterns: "x" }, { id: "", match_patterns: ["x"] }, { id: 5, match_patterns: ["x"] }]) {
      expect((await call("POST", "/api/known-accounts/preview", body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it("fel metod ger 405 och en databas som inte svarar 503", async () => {
    expect((await call("GET", "/api/known-accounts/ka1")).headers.get("allow")).toBe("PUT, DELETE");
    expect((await call("POST", "/api/known-accounts")).headers.get("allow")).toBe("GET");
    expect((await call("GET", "/api/known-accounts/preview")).headers.get("allow")).toBe("POST");
    const broken = { prepare: () => { throw new Error("nere"); }, batch: () => { throw new Error("nere"); } } as unknown as D1Database;
    for (const [method, path, body] of [["GET", "/api/known-accounts"], ["PUT", "/api/known-accounts/ka1", A], ["DELETE", "/api/known-accounts/ka1"], ["POST", "/api/known-accounts/preview", { match_patterns: ["x"] }]] as const) {
      expect((await call(method, path, body, { DB: broken })).status, path).toBe(503);
    }
  });
});
