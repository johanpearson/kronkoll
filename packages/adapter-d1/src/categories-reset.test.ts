import type { D1Database } from "@cloudflare/workers-types";
import { CATEGORY_TEMPLATE, TEMPLATE_RULES } from "@kronkoll/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { categoryRepository, type CategoryRow } from "./categories.ts";
import { migratedDb } from "./test-support.ts";

let db: D1Database;
let dispose: () => Promise<void>;

beforeAll(async () => {
  ({ db, dispose } = await migratedDb());
});
afterAll(async () => {
  await dispose();
});

const count = async (sql: string) => (await db.prepare(sql).first<{ n: number }>())?.n ?? -1;

/** Påhittade rader (KK-13): två kategoriserade transaktioner, en uppdelning, en budgetrad och olika slags regler. */
async function seed() {
  await db.batch([
    db.prepare(`INSERT INTO bank_connections (id, provider, status) VALUES ('c1', 'enablebanking', 'active')`),
    db.prepare(`INSERT INTO accounts (id, connection_id, display_name, type) VALUES ('a1', 'c1', 'Privatkonto', 'checking')`),
    db.prepare(
      `INSERT INTO transactions (id, account_id, fingerprint, status, last_seen_at, transaction_date, amount_minor, category_id, category_source)
       VALUES ('t1', 'a1', 'fp', 'booked', '2026-11-02', '2026-11-02', -100, 'mat-livsmedel', 'manual'),
              ('t2', 'a1', 'fp', 'booked', '2026-11-02', '2026-11-02', -100, 'mat-livsmedel', 'template'),
              ('t3', 'a1', 'fp', 'booked', '2026-11-02', '2026-11-02', -100, NULL, 'none')`,
    ),
    db.prepare(`INSERT INTO transaction_splits (id, transaction_id, category_id, amount_minor) VALUES ('s1', 't1', 'mat-livsmedel', -100)`),
    db.prepare(`INSERT INTO budget_lines (period, category_id, amount_minor) VALUES ('2026-11', 'mat', 600000)`),
    db.prepare(`INSERT INTO category_rules (id, match, pattern, category_id, source) VALUES ('egen', 'counterparty_prefix', 'IKEA', 'mat-livsmedel', 'learned')`),
    db.prepare(`INSERT INTO category_rules (id, match, pattern, category_id, income_type, source) VALUES ('inkomst', 'description_contains', 'BONUS', NULL, 'salary', 'learned')`),
    db.prepare(`INSERT INTO category_rules (id, match, pattern, category_id, source, action) VALUES ('exkl', 'counterparty_prefix', 'PANTEN', NULL, 'learned', 'exclude')`),
  ]);
}

describe("rensa alla kategorier i D1 (KK-48)", () => {
  it("räknar vad en rensning berör utan att ändra något (KK-48-A)", async () => {
    await seed();
    const summary = await categoryRepository(db).resetSummary();
    expect(summary).toMatchObject({ transactions: 2, splits: 1, budgetLines: 1 });
    expect(summary.categories).toBe(CATEGORY_TEMPLATE.length);
    // Mallens regler och den egna, men inte inkomstregeln eller Räkna inte-regeln.
    expect(summary.rules).toBe(TEMPLATE_RULES.length + 1);
    expect(await count(`SELECT count(*) AS n FROM categories`)).toBe(CATEGORY_TEMPLATE.length);
  });

  it("rensar allt till en tom lista utan att radera transaktioner, och rör inte regler som inte sätter en kategori (KK-48-B)", async () => {
    await categoryRepository(db).reset();
    expect(await count(`SELECT count(*) AS n FROM categories`)).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM transactions`)).toBe(3);
    expect(await count(`SELECT count(*) AS n FROM transactions WHERE category_id IS NOT NULL OR category_source <> 'none'`)).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM transaction_splits`)).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM budget_lines`)).toBe(0);
    expect((await db.prepare(`SELECT id FROM category_rules ORDER BY id`).all<{ id: string }>()).results.map((r) => r.id).filter((id) => ["egen", "inkomst", "exkl"].includes(id))).toEqual(["exkl", "inkomst"]);
    expect(await categoryRepository(db).resetSummary()).toEqual({ categories: 0, rules: 0, transactions: 0, splits: 0, budgetLines: 0 });
  });

  it("sätter tillbaka mallen med huvudkategorierna före underkategorierna, och tål att den redan är tom", async () => {
    const template: { categories: CategoryRow[]; rules: typeof TEMPLATE_RULES } = { categories: [...CATEGORY_TEMPLATE].reverse(), rules: TEMPLATE_RULES };
    await categoryRepository(db).reset(template);
    expect(await count(`SELECT count(*) AS n FROM categories`)).toBe(CATEGORY_TEMPLATE.length);
    expect(await count(`SELECT count(*) AS n FROM categories WHERE parent_id IS NOT NULL`)).toBe(CATEGORY_TEMPLATE.filter((c) => c.parentId !== null).length);
    expect(await count(`SELECT count(*) AS n FROM category_rules WHERE id = 'mall-ica' AND category_id = 'mat-livsmedel'`)).toBe(1);
  });
});
