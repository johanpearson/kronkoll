import type { D1Database } from "@cloudflare/workers-types";
import { knownAccountRepository } from "@kronkoll/adapter-d1";
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
  key = await createTestKey("transaction-known-key");
  const { fetchImpl } = jwksFetch(key);
  guardDeps = {
    verifierFor: () => cachedVerifier({ issuer: ISSUER, audience: AUD, allowedEmails: [INVITED], appOrigin: ORIGIN }, fetchImpl),
    logger: captureLogs().logger,
  };
  await db.batch([
    db.prepare(`INSERT INTO bank_connections (id, provider, aspsp_name, status) VALUES ('c1', 'enablebanking', 'Skandia', 'active')`),
    db.prepare(`INSERT INTO accounts (id, connection_id, display_name, type) VALUES ('acc_1', 'c1', 'Privatkonto', 'checking')`),
  ]);
  // Påhittat konto (KK-13). Namnet har HTML i sig, för att visa att det alltid är text (KK-30).
  await knownAccountRepository(db).save({ id: "ka1", name: "<b>Konto A</b>", patterns: ["SWISH TILL A"], categoryId: "boende-laneranta" });
});
afterAll(async () => {
  await dispose();
});
beforeEach(async () => {
  // Påhittade betalningar (KK-13). SL-mallen träffar "sl", så att reglerna kan sätta en kategori igen.
  await db.batch([
    db.prepare(`DELETE FROM transactions`),
    db.prepare(
      `INSERT INTO transactions (id, account_id, fingerprint, status, last_seen_at, transaction_date, booking_date, amount_minor, counterparty, counterparty_norm, description)
       VALUES ('bet', 'acc_1', 'fp', 'booked', '2026-11-02', '2026-11-02', '2026-11-02', -200000, '', '', 'Swish till Exempel B'),
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

const detail = async (id: string) => (await call("GET", `/api/transactions/${id}`)).json<Record<string, unknown>>();

describe("PUT /api/transactions/{id}/known-account (KK-54-C)", () => {
  it("kopplar en överföring till kontot för hand, med kontots kategori, och detaljen visar namnet som text", async () => {
    const res = await call("PUT", "/api/transactions/bet/known-account", { known_account_id: "ka1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ known_account: { id: "ka1", name: "<b>Konto A</b>", source: "manual" }, category_id: "boende-laneranta", category_source: "learned" });
    expect(await detail("bet")).toMatchObject({ known_account: { id: "ka1", name: "<b>Konto A</b>", source: "manual" } });
    const list = await (await call("GET", "/api/transactions?period=2026-11&limit=10")).json<{ items: { id: string; known_account_name: string | null }[] }>();
    expect(list.items.find((i) => i.id === "bet")?.known_account_name).toBe("<b>Konto A</b>");
    expect(list.items.find((i) => i.id === "sl")?.known_account_name).toBeNull();
  });

  it("kan lägga till transaktionens text som ny matchningstext, och inte samma text två gånger", async () => {
    await call("PUT", "/api/transactions/bet/known-account", { known_account_id: "ka1", add_pattern: true });
    await call("PUT", "/api/transactions/bet/known-account", { known_account_id: "ka1", add_pattern: true });
    expect((await knownAccountRepository(db).get("ka1"))?.patterns).toEqual(["SWISH TILL A", "SWISH TILL EXEMPEL B"]);
  });

  it("tar bort kopplingen: reglerna sätter kategorin direkt, och kopplingen kommer inte tillbaka", async () => {
    await call("PUT", "/api/transactions/sl/known-account", { known_account_id: "ka1" });
    expect(await detail("sl")).toMatchObject({ category_id: "boende-laneranta" });
    const res = await call("PUT", "/api/transactions/sl/known-account", { known_account_id: null });
    expect(await res.json()).toEqual({ known_account: null, category_id: "transport-kollektivtrafik", category_source: "template" });
    expect(await db.prepare(`SELECT known_account_source AS s FROM transactions WHERE id = 'sl'`).first()).toEqual({ s: "manual" });
  });

  it("en okänd transaktion eller ett okänt konto ger 404, och felaktig indata 400", async () => {
    expect((await call("PUT", "/api/transactions/saknas/known-account", { known_account_id: "ka1" })).status).toBe(404);
    expect((await call("PUT", "/api/transactions/borta/known-account", { known_account_id: "ka1" })).status).toBe(404);
    expect((await call("PUT", "/api/transactions/bet/known-account", { known_account_id: "saknas" })).status).toBe(404);
    expect((await call("PUT", "/api/transactions/bet/known-account", { known_account_id: "saknas", add_pattern: true })).status).toBe(404);
    for (const body of ["inte json", {}, { known_account_id: 5 }, { known_account_id: "" }, { known_account_id: "x".repeat(65) }, { known_account_id: "ka1", add_pattern: "ja" }, { known_account_id: null, add_pattern: true }]) {
      expect((await call("PUT", "/api/transactions/bet/known-account", body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it("fel metod ger 405 och en databas som inte svarar 503", async () => {
    expect((await call("GET", "/api/transactions/bet/known-account")).headers.get("allow")).toBe("PUT");
    const broken = { prepare: () => { throw new Error("nere"); }, batch: () => { throw new Error("nere"); } } as unknown as D1Database;
    expect((await call("PUT", "/api/transactions/bet/known-account", { known_account_id: "ka1" }, { DB: broken })).status).toBe(503);
  });
});
