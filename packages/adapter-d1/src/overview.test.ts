import type { D1Database } from "@cloudflare/workers-types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deriveKeys } from "./crypto.ts";
import { overviewRepository } from "./overview.ts";
import { accountRepository, connectionRepository } from "./repositories.ts";
import { migratedDb, randomSecret } from "./test-support.ts";

let db: D1Database;
let dispose: () => Promise<void>;

beforeAll(async () => {
  ({ db, dispose } = await migratedDb());
  const keys = await deriveKeys(randomSecret());
  // Påhittade kopplingar och konton (KK-13).
  const connections = connectionRepository(db, keys);
  await connections.create({ id: "c1", provider: "enablebanking", aspspName: "Skandia" });
  await connections.activate("c1", { sessionId: "3f1d2c4b-0000-4000-8000-00000000abcd", consentExpiresOn: "2027-05-01" });
  await connections.recordSyncOutcome("c1", "ok", "2026-11-02T05:02:11.000Z");
  await connections.create({ id: "c2", provider: "enablebanking", aspspName: "SBAB" });
  const accounts = accountRepository(db, keys);
  await accounts.upsertFromBank({ connectionId: "c1", providerUid: "u1", iban: null, name: "Privatkonto", type: "checking", balanceMinor: 4831240 }, () => "acc_1");
  await accounts.upsertFromBank({ connectionId: "c1", providerUid: "u2", iban: null, name: "Kort", type: "credit_card", balanceMinor: null }, () => "acc_2");
  await db.prepare(`INSERT INTO accounts (id, connection_id, display_name, type, balance_minor, included) VALUES ('acc_3', 'c1', 'Lån', 'loan', -200000000, 0)`).run();
});
afterAll(async () => {
  await dispose();
});

describe("översikten i D1 (KK-17, KK-38)", () => {
  it("ger kontonas namn, bank, saldo (null utan saldo från banken) och om de räknas in", async () => {
    await db.prepare(`UPDATE accounts SET nickname = 'Vardag' WHERE id = 'acc_1'`).run();
    expect(await overviewRepository(db).accounts()).toEqual([
      { id: "acc_2", name: "Kort", bank: "Skandia", balanceMinor: null, included: true },
      { id: "acc_3", name: "Lån", bank: "Skandia", balanceMinor: -200000000, included: false },
      { id: "acc_1", name: "Vardag", bank: "Skandia", balanceMinor: 4831240, included: true },
    ]);
    await db.prepare(`UPDATE accounts SET nickname = NULL WHERE id = 'acc_1'`).run();
  });

  it("ger kopplingarnas bank, status, samtyckets slut, senaste lyckade synk, fel i rad och antal konton", async () => {
    expect(await overviewRepository(db).connections()).toEqual([
      { id: "c1", bank: "Skandia", status: "active", consentExpiresOn: "2027-05-01", lastSuccessAt: "2026-11-02T05:02:11.000Z", consecutiveFailures: 0, accountCount: 3 },
      { id: "c2", bank: "SBAB", status: "pending_auth", consentExpiresOn: null, lastSuccessAt: null, consecutiveFailures: 0, accountCount: 0 },
    ]);
  });
});

describe("sidan om en koppling (#34, KK-7-A, KK-37)", () => {
  it("ger kopplingens konton med eget namn när det finns, sorterade efter bankens namn", async () => {
    await db.prepare(`UPDATE accounts SET nickname = 'Gemensamt kort' WHERE id = 'acc_2'`).run();
    expect(await overviewRepository(db).connectionAccounts("c1")).toEqual([
      { id: "acc_2", name: "Gemensamt kort", type: "credit_card", balanceMinor: null },
      { id: "acc_3", name: "Lån", type: "loan", balanceMinor: -200000000 },
      { id: "acc_1", name: "Privatkonto", type: "checking", balanceMinor: 4831240 },
    ]);
    expect(await overviewRepository(db).connectionAccounts("c2")).toEqual([]);
  });

  it("ger de senaste synkkörningarna, nyast först och högst så många som efterfrågas", async () => {
    await db.batch(
      ["2026-11-01T04:07:00.000Z", "2026-11-02T04:07:00.000Z", "2026-11-03T04:07:00.000Z"].map((at, i) =>
        db
          .prepare(`INSERT INTO sync_runs (id, connection_id, kind, started_at, finished_at, status, new_count, updated_count, error_code) VALUES (?, 'c1', 'cron', ?, ?, ?, ?, 0, ?)`)
          .bind(`run-${String(i)}`, at, at, i === 1 ? "failed" : "ok", i, i === 1 ? "UNAVAILABLE" : null),
      ),
    );
    const runs = await overviewRepository(db).syncRuns("c1", 2);
    expect(runs).toEqual([
      { kind: "cron", status: "ok", startedAt: "2026-11-03T04:07:00.000Z", finishedAt: "2026-11-03T04:07:00.000Z", newCount: 2, updatedCount: 0, errorCode: null },
      { kind: "cron", status: "failed", startedAt: "2026-11-02T04:07:00.000Z", finishedAt: "2026-11-02T04:07:00.000Z", newCount: 1, updatedCount: 0, errorCode: "UNAVAILABLE" },
    ]);
  });
});
