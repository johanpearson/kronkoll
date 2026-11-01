import type { D1Database } from "@cloudflare/workers-types";
import { getTableName, isTable } from "drizzle-orm";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "./schema.ts";
import { migratedDb, migrationFiles } from "./test-support.ts";

let db: D1Database;
let dispose: () => Promise<void>;

beforeAll(async () => {
  ({ db, dispose } = await migratedDb());
});
afterAll(async () => {
  await dispose();
});

interface Column {
  name: string;
  type: string;
}

async function columns(table: string): Promise<Column[]> {
  const result = await db.prepare(`SELECT name, lower(type) AS type FROM pragma_table_info(?)`).bind(table).all<Column>();
  return result.results;
}

async function rejects(sql: string, ...params: unknown[]): Promise<boolean> {
  try {
    await db.prepare(sql).bind(...params).run();
    return false;
  } catch {
    return true;
  }
}

const schemaTables: SQLiteTable[] = Object.values(schema).filter((t) => isTable(t));
const tables = schemaTables.map(getTableName).sort();

async function seedConnection(id = "c1") {
  await db.batch([
    db.prepare(`INSERT INTO bank_connections (id, provider, status) VALUES (?, 'enablebanking', 'active')`).bind(id),
    db.prepare(`INSERT INTO accounts (id, connection_id, display_name, type) VALUES (?, ?, 'Privatkonto ••4821', 'checking')`).bind(`${id}-a1`, id),
    db.prepare(
      `INSERT INTO transactions (id, account_id, fingerprint, status, last_seen_at, transaction_date, amount_minor)
       VALUES (?, ?, 'fp', 'booked', '2026-11-01T06:00:00Z', '2026-11-01', -12500)`,
    ).bind(`${id}-t1`, `${id}-a1`),
    db.prepare(`INSERT INTO sync_runs (id, connection_id, kind, started_at, status) VALUES (?, ?, 'cron', '2026-11-01T06:00:00Z', 'ok')`).bind(`${id}-s1`, id),
  ]);
}

describe("migreringarna (KK-14, D-orm)", () => {
  it("har filnamn som wrangler kör i ordning", async () => {
    for (const file of await migrationFiles()) expect(file).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/u);
  });

  it("skapar alla tabeller i schemat", async () => {
    const result = await db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite%' ORDER BY name`).all<{ name: string }>();
    expect(result.results.map((r) => r.name)).toEqual(tables);
  });
});

describe("schemat och migreringarna stämmer överens", () => {
  // Ändras schemat utan att migreringen genereras om, blir det här testet rött.
  it.each(schemaTables.map((t) => [getTableName(t), t] as const))("%s har samma kolumner, index och främmande nycklar", async (name, table) => {
    const config = getTableConfig(table);
    expect((await columns(name)).map((c) => c.name).sort()).toEqual(config.columns.map((c) => c.name).sort());

    const indexes = await db.prepare(`SELECT name FROM pragma_index_list(?) WHERE origin = 'c'`).bind(name).all<{ name: string }>();
    expect(indexes.results.map((i) => i.name).sort()).toEqual(config.indexes.map((i) => i.config.name).sort());

    const fks = await db.prepare(`SELECT "table" AS target, "from" AS col, on_delete FROM pragma_foreign_key_list(?)`).bind(name).all<{ target: string; col: string; on_delete: string }>();
    const expected = config.foreignKeys.map((fk) => {
      const ref = fk.reference();
      return { target: getTableName(ref.foreignTable), col: ref.columns[0]?.name, on_delete: (fk.onDelete ?? "no action").toUpperCase() };
    });
    expect(fks.results.sort((a, b) => a.col.localeCompare(b.col))).toEqual(expected.sort((a, b) => (a.col ?? "").localeCompare(b.col ?? "")));
    const created = await db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).bind(name).first<{ sql: string }>();
    expect(created?.sql.match(/CONSTRAINT "/gu)?.length ?? 0).toBe(config.checks.length);
  });
});

describe("en användare och en inställningsrad (KK-28-A)", () => {
  it("har exakt en inställningsrad med kalendermånad och svensk tid", async () => {
    expect((await db.prepare(`SELECT * FROM settings`).all()).results).toEqual([
      { id: "settings", budget_period_start_day: 1, timezone: "Europe/Stockholm" },
    ]);
  });

  it("tillåter ingen andra rad och ingen startdag utanför 1–28", async () => {
    expect(await rejects(`INSERT INTO settings (id) VALUES ('annan')`)).toBe(true);
    expect(await rejects(`UPDATE settings SET budget_period_start_day = 29`)).toBe(true);
    expect(await rejects(`UPDATE settings SET budget_period_start_day = 25`)).toBe(false);
  });

  it("har inga hushålls-, ägar- eller synlighetsfält", async () => {
    for (const table of tables) {
      for (const column of await columns(table)) expect(column.name).not.toMatch(/household|owner|visibility|shared/u);
    }
  });
});

describe("lagringsminimering (KK-11-C, V-i-storage)", () => {
  it("har inga kolumner för råa svar, JSON, IBAN eller session-id i klartext", async () => {
    for (const table of tables) {
      for (const column of await columns(table)) {
        expect(column.name).not.toMatch(/raw|json|payload|response|^iban$|^session_id$|account_number/u);
        expect(column.type).not.toBe("json");
      }
    }
    expect(await columns("bank_connections")).toContainEqual({ name: "session_id_enc", type: "blob" });
    expect(await columns("accounts")).toContainEqual({ name: "iban_hash", type: "text" });
  });

  it("alla belopp är heltal (D-money)", async () => {
    for (const table of tables) {
      for (const column of (await columns(table)).filter((c) => c.name.endsWith("_minor"))) {
        expect(column.type, `${table}.${column.name}`).toBe("integer");
      }
    }
  });

  it("beskrivningen är högst 140 tecken och felkoden kan inte innehålla svarstext", async () => {
    await seedConnection("m1");
    expect(await rejects(`UPDATE transactions SET description = ? WHERE id = 'm1-t1'`, "x".repeat(141))).toBe(true);
    expect(await rejects(`UPDATE sync_runs SET error_code = ? WHERE id = 'm1-s1'`, "Bank says: account 1234 blocked")).toBe(true);
    expect(await rejects(`UPDATE sync_runs SET error_code = 'EB_429' WHERE id = 'm1-s1'`)).toBe(false);
  });
});

describe("radering och integritet (KK-11)", () => {
  it("raderas en koppling försvinner dess konton, transaktioner och uppdelningar, men driftloggen blir kvar", async () => {
    await seedConnection("r1");
    await db.prepare(`INSERT INTO transaction_splits (id, transaction_id, category_id, amount_minor) VALUES ('sp1', 'r1-t1', 'mat', -12500)`).run();

    await db.prepare(`DELETE FROM bank_connections WHERE id = 'r1'`).run();

    const count = async (sql: string) => (await db.prepare(sql).first<{ n: number }>())?.n;
    expect(await count(`SELECT count(*) AS n FROM accounts WHERE connection_id = 'r1'`)).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM transactions WHERE id = 'r1-t1'`)).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM transaction_splits WHERE id = 'sp1'`)).toBe(0);
    expect(await db.prepare(`SELECT connection_id FROM sync_runs WHERE id = 'r1-s1'`).first()).toEqual({ connection_id: null });
  });

  it("samma bank-id kan inte finnas två gånger på ett konto, men saknade id:n är tillåtna", async () => {
    await seedConnection("u1");
    const insert = (id: string, providerTxId: string | null) =>
      rejects(
        `INSERT INTO transactions (id, account_id, provider_tx_id, fingerprint, status, last_seen_at, transaction_date, amount_minor)
         VALUES (?, 'u1-a1', ?, 'fp', 'pending', '2026-11-01T06:00:00Z', '2026-11-01', -100)`,
        id,
        providerTxId,
      );
    expect(await insert("u1-x", "EB-1")).toBe(false);
    expect(await insert("u1-y", "EB-1")).toBe(true);
    expect(await insert("u1-z1", null)).toBe(false);
    expect(await insert("u1-z2", null)).toBe(false);
  });

  it("avvisar okända statusvärden, ogiltiga datum och budget på okänd kategori", async () => {
    await seedConnection("v1");
    expect(await rejects(`UPDATE transactions SET status = 'deleted' WHERE id = 'v1-t1'`)).toBe(true);
    expect(await rejects(`UPDATE transactions SET transaction_date = '1 nov' WHERE id = 'v1-t1'`)).toBe(true);
    expect(await rejects(`UPDATE bank_connections SET status = 'hacked' WHERE id = 'v1'`)).toBe(true);
    expect(await rejects(`INSERT INTO budget_lines (period, category_id, amount_minor) VALUES ('2026-11', 'finns-inte', 100)`)).toBe(true);
    expect(await rejects(`INSERT INTO budget_lines (period, category_id, amount_minor) VALUES ('nov', 'mat', 100)`)).toBe(true);
  });
});
