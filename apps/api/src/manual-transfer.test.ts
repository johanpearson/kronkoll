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
  key = await createTestKey("manual-transfer-key");
  const { fetchImpl } = jwksFetch(key);
  guardDeps = {
    verifierFor: () => cachedVerifier({ issuer: ISSUER, audience: AUD, allowedEmails: [INVITED], appOrigin: ORIGIN }, fetchImpl),
    logger: captureLogs().logger,
  };
  await connectionRepository(db, keys).create({ id: "c1", provider: "enablebanking", aspspName: "Skandia" });
  const accounts = accountRepository(db, keys);
  await accounts.upsertFromBank({ connectionId: "c1", providerUid: "u1", iban: null, name: "Budget", type: "checking", balanceMinor: 0 }, () => "acc_budget");
  await accounts.upsertFromBank({ connectionId: "c1", providerUid: "u2", iban: null, name: "Spar", type: "savings", balanceMinor: 0 }, () => "acc_spar");
});
afterAll(async () => {
  await dispose();
});

/** Påhittade transaktioner (KK-13): en överföring mellan egna konton, en till SBAB och ett köp. */
beforeEach(async () => {
  await db.prepare(`DELETE FROM transactions`).run();
  const rows: [string, string, number, string][] = [
    ["ut", "acc_budget", -500000, "SPARKONTO"],
    ["in", "acc_spar", 500000, "BUDGETKONTO"],
    ["sbab", "acc_budget", -300000, "SBAB"],
    ["kop", "acc_budget", -4500, "ESPRESSO HOUSE"],
  ];
  await db.batch(
    rows.map(([id, account, amount, norm]) =>
      db
        .prepare(
          `INSERT INTO transactions (id, account_id, fingerprint, status, last_seen_at, transaction_date, amount_minor, counterparty, counterparty_norm)
           VALUES (?, ?, 'fp', 'booked', '2026-11-02', '2026-11-02', ?, ?, ?)`,
        )
        .bind(id, account, amount, norm, norm),
    ),
  );
  // Paret sätts efteråt: motposten måste finnas innan någon pekar på den.
  await db.batch([
    db.prepare(`UPDATE transactions SET is_internal_transfer = 1, transfer_pair_id = 'in' WHERE id = 'ut'`),
    db.prepare(`UPDATE transactions SET is_internal_transfer = 1, transfer_pair_id = 'ut' WHERE id = 'in'`),
  ]);
});

async function put(id: string, body: unknown, init: { csrf?: boolean; method?: string } = {}) {
  const context: RouteContext = {
    waitUntil: () => undefined,
    sync: { logger: captureLogs().logger, clock: fixedClock("2026-11-15T10:00:00.000Z"), newId: () => "x", providerFor: () => null },
    connectorFor: () => null,
  };
  const headers = new Headers({ "cf-access-jwt-assertion": await signToken(key), "content-type": "application/json" });
  if (init.csrf !== false) {
    headers.set("origin", ORIGIN);
    headers.set("x-kronkoll", "1");
  }
  const method = init.method ?? "PUT";
  const request = new Request(`${ORIGIN}/api/transactions/${id}/transfer`, { method, headers, ...(method === "GET" ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
  return handle(request, configuredEnv({ DB: db }), guardDeps, context);
}

const flags = async () =>
  (await db.prepare(`SELECT id, is_internal_transfer AS i, manual_transfer AS m FROM transactions ORDER BY id`).all<{ id: string; i: number; m: number | null }>()).results;

describe("PUT /api/transactions/{id}/transfer (KK-20-C)", () => {
  it("\"räkna inte som utgift\" på en överföring till ett konto som inte är kopplat", async () => {
    const res = await put("sbab", { internal: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ transaction_id: "sbab", internal: true, manual: true });
    expect((await flags()).find((r) => r.id === "sbab")).toEqual({ id: "sbab", i: 1, m: 1 });
  });

  it("\"räkna som utgift\" på en ihopparad överföring släpper också motposten", async () => {
    const res = await put("ut", { internal: false });
    expect(await res.json()).toEqual({ transaction_id: "ut", internal: false, manual: true });
    expect(await flags()).toEqual([
      { id: "in", i: 0, m: null },
      { id: "kop", i: 0, m: null },
      { id: "sbab", i: 0, m: null },
      { id: "ut", i: 0, m: 0 },
    ]);
  });

  it("automatiskt igen tar bort valet och låter parningen bestämma", async () => {
    await put("ut", { internal: false });
    const res = await put("ut", { internal: null });
    expect(await res.json()).toEqual({ transaction_id: "ut", internal: true, manual: false });
    expect((await flags()).filter((r) => r.i === 1).map((r) => r.id)).toEqual(["in", "ut"]);
  });

  it.each([
    ["inget val", {}],
    ["fel typ", { internal: "ja" }],
    ["inte JSON", "{"],
  ])("%s ger 400 och ändrar ingenting", async (_, body) => {
    const res = await put("kop", body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
    expect((await flags()).find((r) => r.id === "kop")).toEqual({ id: "kop", i: 0, m: null });
  });

  it("en transaktion som inte finns ger 404", async () => {
    const res = await put("saknas", { internal: true });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("kräver CSRF-skydd och PUT", async () => {
    expect((await put("kop", { internal: true }, { csrf: false })).status).toBe(403);
    const res = await put("kop", undefined, { method: "GET" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("PUT");
  });
});
