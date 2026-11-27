// Migreringen till kontoroller (KK-53-B, V-i-roles) körs på konton som har de gamla brytarna.
import type { D1Database } from "@cloudflare/workers-types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigration, migratedDb } from "./test-support.ts";

const MIGRATION = "0021_accounts_role.sql";
let db: D1Database;
let dispose: () => Promise<void>;

beforeAll(async () => {
  ({ db, dispose } = await migratedDb({ before: MIGRATION }));
  const account = (id: string, included: number, saving: number) =>
    db.prepare(`INSERT INTO accounts (id, connection_id, display_name, type, included, saving) VALUES (?, 'c1', 'Konto ••0000', 'checking', ?, ?)`).bind(id, included, saving);
  await db.batch([
    db.prepare(`INSERT INTO bank_connections (id, provider, status) VALUES ('c1', 'enablebanking', 'active')`),
    account("vanligt", 1, 0),
    account("buffert", 1, 1),
    account("privat", 0, 0),
    account("privat-spar", 0, 1),
    db.prepare(
      `INSERT INTO transactions (id, account_id, fingerprint, status, last_seen_at, transaction_date, amount_minor)
       VALUES ('t1', 'buffert', 'fp', 'booked', '2026-11-01T06:00:00Z', '2026-11-01', -12500)`,
    ),
  ]);
  await applyMigration(db, MIGRATION);
});
afterAll(async () => {
  await dispose();
});

describe("migreringen till kontoroller (KK-53-B)", () => {
  it("ger dagens konton en roll från brytarna Räknas med och Sparkonto", async () => {
    const rows = await db.prepare(`SELECT id, role FROM accounts ORDER BY id`).all<{ id: string; role: string }>();
    expect(rows.results).toEqual([
      { id: "buffert", role: "buffer" },
      { id: "privat", role: "excluded" },
      { id: "privat-spar", role: "excluded" },
      { id: "vanligt", role: "spending" },
    ]);
  });

  it("behåller transaktionerna, eftersom tabellen inte byggs om", async () => {
    expect(await db.prepare(`SELECT count(*) AS n FROM transactions`).first("n")).toBe(1);
  });

  it("ger nya konton rollen Inkomst/Utgift och avvisar okända roller", async () => {
    await db.prepare(`INSERT INTO accounts (id, connection_id, display_name, type) VALUES ('ny', 'c1', 'Konto ••1111', 'checking')`).run();
    expect(await db.prepare(`SELECT role FROM accounts WHERE id = 'ny'`).first("role")).toBe("spending");
    await expect(db.prepare(`UPDATE accounts SET role = 'savings' WHERE id = 'ny'`).run()).rejects.toThrow();
  });
});
