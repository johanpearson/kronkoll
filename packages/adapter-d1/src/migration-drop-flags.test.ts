// Migreringen som tar bort de gamla brytarna (KK-53-B) körs på ett konto med transaktioner. Kontot och
// transaktionerna ska finnas kvar med sin roll, eftersom en ombyggd tabell hade raderat dem via kaskaden.
import type { D1Database } from "@cloudflare/workers-types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigration, migratedDb } from "./test-support.ts";

const MIGRATION = "0023_accounts_drop_flags.sql";
let db: D1Database;
let dispose: () => Promise<void>;

beforeAll(async () => {
  ({ db, dispose } = await migratedDb({ before: MIGRATION }));
  await db.batch([
    db.prepare(`INSERT INTO bank_connections (id, provider, status) VALUES ('c1', 'enablebanking', 'active')`),
    db.prepare(`INSERT INTO accounts (id, connection_id, display_name, type, included, saving, role) VALUES ('buffert', 'c1', 'Konto ••0000', 'savings', 1, 1, 'buffer')`),
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

describe("0023: included och saving tas bort (KK-53-B)", () => {
  it("tar bort kolumnerna men behåller kontot, rollen och transaktionerna", async () => {
    const columns = await db.prepare(`SELECT name FROM pragma_table_info('accounts')`).all<{ name: string }>();
    const names = columns.results.map((c) => c.name);
    expect(names).toContain("role");
    expect(names).not.toContain("included");
    expect(names).not.toContain("saving");
    expect(await db.prepare(`SELECT role FROM accounts WHERE id = 'buffert'`).first("role")).toBe("buffer");
    expect(await db.prepare(`SELECT count(*) AS n FROM transactions`).first("n")).toBe(1);
  });
});
