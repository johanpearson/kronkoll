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

describe("översikten i D1 (KK-17)", () => {
  it("ger kontonas saldon, noll för ett konto utan saldo, och om de räknas in", async () => {
    expect(await overviewRepository(db).accounts()).toEqual(
      expect.arrayContaining([
        { balanceMinor: 4831240, included: true },
        { balanceMinor: 0, included: true },
        { balanceMinor: -200000000, included: false },
      ]),
    );
  });

  it("ger kopplingarnas bank, status, samtyckets slut och senaste lyckade synk", async () => {
    expect(await overviewRepository(db).connections()).toEqual([
      { bank: "Skandia", status: "active", consentExpiresOn: "2027-05-01", lastSuccessAt: "2026-11-02T05:02:11.000Z" },
      { bank: "SBAB", status: "pending_auth", consentExpiresOn: null, lastSuccessAt: null },
    ]);
  });
});
