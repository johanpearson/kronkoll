import type { D1Database } from "@cloudflare/workers-types";
import { CATEGORY_TEMPLATE } from "@kronkoll/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { categoryRepository } from "./categories.ts";
import { deriveKeys } from "./crypto.ts";
import { accountRepository, connectionRepository } from "./repositories.ts";
import { migratedDb, randomSecret } from "./test-support.ts";

let db: D1Database;
let dispose: () => Promise<void>;

beforeAll(async () => {
  ({ db, dispose } = await migratedDb());
});
afterAll(async () => {
  await dispose();
});

/** Påhittade rader (KK-13) som pekar på kategorin Bar & uteliv. */
async function seedForMerge() {
  const keys = await deriveKeys(randomSecret());
  await connectionRepository(db, keys).create({ id: "c1", provider: "enablebanking", aspspName: "Skandia" });
  await accountRepository(db, keys).upsertFromBank({ connectionId: "c1", providerUid: "u1", iban: null, name: "Privatkonto", type: "checking", balanceMinor: 0 }, () => "acc_1");
  await db.batch([
    db.prepare(
      `INSERT INTO transactions (id, account_id, fingerprint, status, last_seen_at, transaction_date, amount_minor, category_id, category_source)
       VALUES ('bar', 'acc_1', 'fp', 'booked', '2026-11-02', '2026-11-02', -12000, 'noje-bar-uteliv', 'manual'),
              ('delad', 'acc_1', 'fp', 'booked', '2026-11-03', '2026-11-03', -20000, NULL, 'none')`,
    ),
    db.prepare(`INSERT INTO transaction_splits (id, transaction_id, category_id, amount_minor) VALUES ('s-bar', 'delad', 'noje-bar-uteliv', -20000)`),
    db.prepare(`INSERT INTO category_rules (id, match, pattern, category_id, source) VALUES ('r-bar', 'counterparty_prefix', 'BARRIKADEN', 'noje-bar-uteliv', 'learned')`),
    db.prepare(
      `INSERT INTO budget_lines (period, category_id, amount_minor) VALUES ('2026-11', 'noje-bar-uteliv', 50000), ('2026-11', 'mat-restaurang-cafe', 100000), ('2026-10', 'noje-bar-uteliv', 50000)`,
    ),
  ]);
}

describe("kategorier i D1 (KK-18-A)", () => {
  it("ger startmallens kategorier med förälder, namn, typ och arkivering", async () => {
    const list = await categoryRepository(db).list();
    const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
    expect([...list].sort(byId)).toEqual(
      [...CATEGORY_TEMPLATE].map((c) => ({ id: c.id, parentId: c.parentId, name: c.name, kind: c.kind, archived: c.archived })).sort(byId),
    );
  });

  it("sparar en ny kategori och ändrade namn, arkivering och förälder", async () => {
    const repo = categoryRepository(db);
    await repo.insert({ id: "barn-simskola", parentId: "fritid", name: "Simskola", kind: "expense", archived: false });
    await repo.save([
      { id: "barn-simskola", parentId: "fritid", name: "Simskola & bad", kind: "expense", archived: false },
      { id: "noje-spel", parentId: "noje", name: "Spel", kind: "expense", archived: true },
    ]);
    const list = await repo.list();
    expect(list.find((c) => c.id === "barn-simskola")).toEqual({ id: "barn-simskola", parentId: "fritid", name: "Simskola & bad", kind: "expense", archived: false });
    expect(list.find((c) => c.id === "noje-spel")?.archived).toBe(true);
  });

  it("slår ihop: flyttar transaktioner, uppdelningar, regler och budget till den nya kategorin", async () => {
    await seedForMerge();
    const repo = categoryRepository(db);
    const moved = await repo.merge("noje-bar-uteliv", "mat-restaurang-cafe", [
      { id: "noje-bar-uteliv", parentId: "noje", name: "Bar & uteliv", kind: "expense", archived: true },
    ]);
    expect(moved).toBe(1);
    const one = async (sql: string) => db.prepare(sql).first();
    expect(await one(`SELECT category_id AS c FROM transactions WHERE id = 'bar'`)).toEqual({ c: "mat-restaurang-cafe" });
    expect(await one(`SELECT category_id AS c FROM transaction_splits WHERE id = 's-bar'`)).toEqual({ c: "mat-restaurang-cafe" });
    expect(await one(`SELECT category_id AS c FROM category_rules WHERE id = 'r-bar'`)).toEqual({ c: "mat-restaurang-cafe" });
    // Samma period: beloppen läggs ihop. Bara den gamla: raden flyttas.
    const lines = await db.prepare(`SELECT period, category_id AS c, amount_minor AS a FROM budget_lines ORDER BY period, c`).all();
    expect(lines.results).toEqual([
      { period: "2026-10", c: "mat-restaurang-cafe", a: 50000 },
      { period: "2026-11", c: "mat-restaurang-cafe", a: 150000 },
    ]);
    expect((await repo.list()).find((c) => c.id === "noje-bar-uteliv")?.archived).toBe(true);
  });

  it("tar med arkiverade kategorier, så att äldre transaktioner fortfarande får ett namn", async () => {
    await db.prepare(`UPDATE categories SET archived = 1 WHERE id = 'mat-systembolaget'`).run();
    expect((await categoryRepository(db).list()).find((c) => c.id === "mat-systembolaget")).toMatchObject({ archived: true, name: "Systembolaget" });
  });
});
