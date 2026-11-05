import type { D1Database } from "@cloudflare/workers-types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deriveKeys } from "./crypto.ts";
import { insightsRepository } from "./insights.ts";
import { accountRepository, connectionRepository } from "./repositories.ts";
import { migratedDb, randomSecret } from "./test-support.ts";

let db: D1Database;
let dispose: () => Promise<void>;

/** Påhittade transaktioner (KK-13). */
beforeAll(async () => {
  ({ db, dispose } = await migratedDb());
  const keys = await deriveKeys(randomSecret());
  await connectionRepository(db, keys).create({ id: "c1", provider: "enablebanking", aspspName: "Skandia" });
  await accountRepository(db, keys).upsertFromBank({ connectionId: "c1", providerUid: "u1", iban: null, name: "Privatkonto", type: "checking", balanceMinor: 0 }, () => "acc_1");
  const rows: [string, string, string | null, string, number, string, string, number][] = [
    ["netflix", "2026-10-18", "2026-10-19", "booked", -14900, "Netflix", "", 0],
    ["lidl", "2026-10-02", null, "pending", -35000, "", "LIDL188PAHITTAD, STOCKHOLM", 0],
    ["lon", "2026-10-25", "2026-10-25", "booked", 3000000, "Arbetsgivaren AB", "", 0],
    ["intern", "2026-10-05", "2026-10-05", "booked", -500000, "", "Till sparkonto", 1],
    ["borta", "2026-10-07", null, "removed", -9900, "Kiosk", "", 0],
    ["fore", "2026-08-31", "2026-08-31", "booked", -100, "Tidigt", "", 0],
    ["efter", "2026-11-01", "2026-11-01", "booked", -100, "Sent", "", 0],
  ];
  await db.batch(
    rows.map(([id, date, booking, status, amount, counterparty, description, internal]) =>
      db
        .prepare(
          `INSERT INTO transactions (id, account_id, fingerprint, status, last_seen_at, transaction_date, booking_date, amount_minor, counterparty, counterparty_norm, description, category_source, is_internal_transfer)
           VALUES (?, 'acc_1', 'fp', ?, ?, ?, ?, ?, ?, upper(?), ?, 'none', ?)`,
        )
        .bind(id, status, date, date, booking, amount, counterparty, counterparty, description, internal),
    ),
  );
});
afterAll(async () => {
  await dispose();
});

describe("utbetalningar för insikter i D1 (KK-24)", () => {
  it("ger utbetalningar i intervallet, äldst först, med bokföringsdagen som datum och utan inkomster och borttagna", async () => {
    const rows = await insightsRepository(db).charges("2026-09-01", "2026-10-31");
    expect(rows.map((r) => r.id)).toEqual(["lidl", "intern", "netflix"]);
    expect(rows[2]).toEqual({ id: "netflix", date: "2026-10-19", amountMinor: -14900, counterparty: "Netflix", counterpartyNorm: "NETFLIX", description: "", status: "booked", internal: false });
    expect(rows[0]).toMatchObject({ date: "2026-10-02", counterparty: "", description: "LIDL188PAHITTAD, STOCKHOLM", status: "pending" });
    expect(rows[1]).toMatchObject({ internal: true });
  });

  it("tar med intervallets första och sista dag", async () => {
    expect((await insightsRepository(db).charges("2026-08-31", "2026-11-01")).map((r) => r.id)).toEqual(["fore", "lidl", "intern", "netflix", "efter"]);
  });
});
