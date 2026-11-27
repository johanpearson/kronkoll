// Migreringen som ger de egna reglerna en plats i användarens ordning (KK-58-C). Befintliga egna regler får
// platser i den inbyggda prioriteten, så att ingen transaktion byter kategori förrän användaren ordnar om.
import type { D1Database } from "@cloudflare/workers-types";
import { categorize, type CategorizableTransaction } from "@kronkoll/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ruleRepository } from "./rules.ts";
import { applyMigration, migratedDb } from "./test-support.ts";

const MIGRATION = "0024_category_rules_position.sql";
let db: D1Database;
let dispose: () => Promise<void>;

/** Påhittade egna regler i en ordning där kolumnordningen inte är prioriteten. */
const RULES: [string, string, string, string][] = [
  ["e-innehaller", "description_contains", "MAXI", "hushall-forbrukning"],
  ["e-kort", "counterparty_prefix", "ICA", "mat-livsmedel"],
  ["e-lang", "counterparty_prefix", "ICA MAXI", "mat-restaurang-cafe"],
  ["e-exakt", "counterparty_exact", "ICA MAXI HOOR", "fritid-hobby"],
];

beforeAll(async () => {
  ({ db, dispose } = await migratedDb({ before: MIGRATION }));
  await db.batch([
    ...RULES.map(([id, match, pattern, category]) =>
      db.prepare(`INSERT INTO category_rules (id, match, pattern, category_id, source) VALUES (?, ?, ?, ?, 'learned')`).bind(id, match, pattern, category),
    ),
    db.prepare(`INSERT INTO category_rules (id, match, pattern, category_id, source, action) VALUES ('e-exkl', 'counterparty_prefix', 'PANTEN', NULL, 'learned', 'exclude')`),
  ]);
  await applyMigration(db, MIGRATION);
});
afterAll(async () => {
  await dispose();
});

describe("0024: egna regler får en plats (KK-58-C)", () => {
  it("ger de egna kategoriregler platser i den inbyggda prioriteten: exakt, prefix, innehåller, längre först", async () => {
    const rows = await db.prepare(`SELECT id, position FROM category_rules WHERE source = 'learned' ORDER BY position, id`).all<{ id: string; position: number | null }>();
    expect(rows.results).toEqual([
      // En Räkna inte-regel har ingen plats.
      { id: "e-exkl", position: null },
      { id: "e-exakt", position: 0 },
      { id: "e-lang", position: 1 },
      { id: "e-kort", position: 2 },
      { id: "e-innehaller", position: 3 },
    ]);
  });

  it("mallreglerna får ingen plats", async () => {
    expect(await db.prepare(`SELECT count(*) AS n FROM category_rules WHERE source = 'template' AND position IS NOT NULL`).first("n")).toBe(0);
  });

  it("samma regel vinner som före migreringen", async () => {
    const rules = await ruleRepository(db).list();
    const tx = (counterpartyNorm: string, description = ""): CategorizableTransaction => ({ id: "t", counterpartyNorm, description, categoryId: null, categorySource: "none" });
    expect(categorize(tx("ICA MAXI HOOR"), rules)?.ruleId).toBe("e-exakt");
    expect(categorize(tx("ICA MAXI LUND"), rules)?.ruleId).toBe("e-lang");
    expect(categorize(tx("ICA NARA"), rules)?.ruleId).toBe("e-kort");
    expect(categorize(tx("COOP", "Kortköp MAXI"), rules)?.ruleId).toBe("e-innehaller");
  });
});
