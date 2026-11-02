import type { D1Database } from "@cloudflare/workers-types";
import { accountRepository, connectionRepository, deriveKeys } from "@kronkoll/adapter-d1";
import { migratedDb, randomSecret } from "@kronkoll/adapter-d1/test-support";
import { fixedClock } from "@kronkoll/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  key = await createTestKey("detail-key");
  const { fetchImpl } = jwksFetch(key);
  guardDeps = {
    verifierFor: () => cachedVerifier({ issuer: ISSUER, audience: AUD, allowedEmails: [INVITED], appOrigin: ORIGIN }, fetchImpl),
    logger: captureLogs().logger,
  };
  await connectionRepository(db, keys).create({ id: "c1", provider: "enablebanking", aspspName: "Skandia" });
  const accounts = accountRepository(db, keys);
  await accounts.upsertFromBank({ connectionId: "c1", providerUid: "u1", iban: "SE45 5000 0000 0583 9825 7466", name: "Privatkonto", type: "checking", balanceMinor: 0 }, () => "acc_budget");
  await accounts.upsertFromBank({ connectionId: "c1", providerUid: "u2", iban: null, name: "Sparkonto", type: "savings", balanceMinor: 0 }, () => "acc_spar");
  // Påhittade transaktioner (KK-13).
  const rows: [string, string, string, string | null, number, string, string, string, string | null, string][] = [
    ["kop", "acc_budget", "pending", null, -41250, "K*ICA NARA SOFO 4711 STHLM", "ICA NARA SOFO", "Kortköp 2026-11-01", "mat-livsmedel", "template"],
    ["ut", "acc_budget", "booked", "2026-11-03", -500000, "SPARKONTO", "SPARKONTO", "Överföring", null, "none"],
    ["in", "acc_spar", "booked", "2026-11-03", 500000, "PRIVATKONTO", "PRIVATKONTO", "Överföring", null, "none"],
    ["delad", "acc_budget", "booked", "2026-10-31", -124000, "CLAS OHLSON", "CLAS OHLSON", "", null, "none"],
    ["borta", "acc_budget", "removed", null, -100, "X", "X", "", null, "none"],
  ];
  await db.batch(
    rows.map(([id, account, status, booking, amount, cp, norm, desc, cat, source]) =>
      db
        .prepare(
          `INSERT INTO transactions (id, account_id, fingerprint, status, last_seen_at, transaction_date, booking_date, amount_minor, counterparty, counterparty_norm, description, category_id, category_source)
           VALUES (?, ?, 'fp', ?, '2026-11-03', '2026-11-01', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, account, status, booking, amount, cp, norm, desc, cat, source),
    ),
  );
  await db.batch([
    db.prepare(`UPDATE transactions SET is_internal_transfer = 1, transfer_pair_id = 'in', manual_transfer = NULL WHERE id = 'ut'`),
    db.prepare(`UPDATE transactions SET is_internal_transfer = 1, transfer_pair_id = 'ut' WHERE id = 'in'`),
    db.prepare(`INSERT INTO transaction_splits (id, transaction_id, category_id, amount_minor) VALUES ('s1', 'delad', 'hushall-forbrukning', -90000), ('s2', 'delad', 'fritid-hobby', -34000)`),
  ]);
});
afterAll(async () => {
  await dispose();
});

async function get(id: string, env: Partial<{ DB: D1Database }> = {}) {
  const context: RouteContext = {
    waitUntil: () => undefined,
    sync: { logger: captureLogs().logger, clock: fixedClock("2026-11-15T10:00:00.000Z"), newId: () => "x", providerFor: () => null },
    connectorFor: () => null,
  };
  const headers = new Headers({ "cf-access-jwt-assertion": await signToken(key) });
  return handle(new Request(`${ORIGIN}/api/transactions/${id}`, { headers }), configuredEnv({ DB: db, ...env }), guardDeps, context);
}

describe("GET /api/transactions/{id} (#32, KK-9, KK-18, KK-19, KK-20-C, KK-30)", () => {
  it("ger allt om en transaktion, med kontots maskerade namn och bankens råa text", async () => {
    const res = await get("kop");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: "kop",
      account: { id: "acc_budget", name: "Privatkonto ••7466", type: "checking" },
      status: "pending",
      transaction_date: "2026-11-01",
      booking_date: null,
      amount_minor: -41250,
      counterparty: "K*ICA NARA SOFO 4711 STHLM",
      counterparty_norm: "ICA NARA SOFO",
      description: "Kortköp 2026-11-01",
      category_id: "mat-livsmedel",
      category_source: "template",
      is_internal_transfer: false,
      manual_transfer: null,
      transfer_pair: null,
      splits: [],
    });
  });

  it("visar motposten för en intern överföring", async () => {
    const body = await (await get("ut")).json<Record<string, unknown>>();
    expect(body).toMatchObject({
      is_internal_transfer: true,
      transfer_pair: { id: "in", account_name: "Sparkonto", amount_minor: 500000, transaction_date: "2026-11-01" },
    });
  });

  it("visar delarna i en uppdelad transaktion", async () => {
    const body = await (await get("delad")).json<Record<string, unknown>>();
    expect(body.splits).toEqual([
      { category_id: "hushall-forbrukning", amount_minor: -90000 },
      { category_id: "fritid-hobby", amount_minor: -34000 },
    ]);
  });

  it.each(["saknas", "borta"])("%s (saknas eller borttagen) ger 404", async (id) => {
    const res = await get(id);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("svarar 503 utan detaljer när databasen inte går att läsa", async () => {
    const broken = { prepare: () => { throw new Error("D1 nere"); } } as unknown as D1Database;
    const res = await get("kop", { DB: broken });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
  });
});
