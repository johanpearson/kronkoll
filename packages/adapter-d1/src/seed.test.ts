import type { D1Database } from "@cloudflare/workers-types";
import { CATEGORY_TEMPLATE, INCOME_TEMPLATE_RULES, TEMPLATE_RULES } from "@kronkoll/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migratedDb } from "./test-support.ts";

let db: D1Database;
let dispose: () => Promise<void>;

beforeAll(async () => {
  ({ db, dispose } = await migratedDb());
});
afterAll(async () => {
  await dispose();
});

describe("startmallen i databasen (KK-18-A)", () => {
  // Ändras mallen i domänen måste en ny migrering skrivas. Det här testet påminner om det.
  it("innehåller exakt kategorierna i CATEGORY_TEMPLATE", async () => {
    const rows = await db
      .prepare(`SELECT id, parent_id AS parentId, name, kind, archived FROM categories ORDER BY rowid`)
      .all<{ id: string; parentId: string | null; name: string; kind: string; archived: number }>();
    expect(rows.results.map((r) => ({ ...r, archived: r.archived === 1 }))).toEqual(CATEGORY_TEMPLATE);
  });

  it("innehåller exakt mallreglerna i TEMPLATE_RULES", async () => {
    const rows = await db
      .prepare(`SELECT id, match, pattern, category_id AS categoryId, source FROM category_rules WHERE category_id IS NOT NULL ORDER BY rowid`)
      .all();
    expect(rows.results).toEqual(TEMPLATE_RULES);
  });

  it("innehåller exakt inkomstreglerna i INCOME_TEMPLATE_RULES (KK-22-A)", async () => {
    const rows = await db
      .prepare(`SELECT id, match, pattern, income_type AS incomeType, source FROM category_rules WHERE income_type IS NOT NULL AND category_id IS NULL ORDER BY rowid`)
      .all();
    expect(rows.results).toEqual(INCOME_TEMPLATE_RULES);
  });
});
