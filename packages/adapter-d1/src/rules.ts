/**
 * Kategoriseringsregler i D1 (KK-18). Mallreglerna kommer från migreringen 0002, inlärda regler
 * från "Gör alltid så". Regler som domänen ännu inte kan använda (beloppsintervall och regler som
 * bara sätter inkomsttyp, KK-22) hoppas över här, så att de aldrig ger fel kategori.
 */
import type { D1Database } from "@cloudflare/workers-types";
import type { CategoryRule } from "@kronkoll/domain";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { categoryRules } from "./schema.ts";

const SUPPORTED_MATCH = new Set<string>(["counterparty_exact", "counterparty_prefix", "description_contains"] satisfies CategoryRule["match"][]);

export function ruleRepository(d1: D1Database) {
  const db = drizzle(d1);
  return {
    async list(): Promise<CategoryRule[]> {
      const rows = await db.select().from(categoryRules).all();
      return rows.flatMap((row): CategoryRule[] =>
        row.categoryId !== null && SUPPORTED_MATCH.has(row.match)
          ? [{ id: row.id, match: row.match as CategoryRule["match"], pattern: row.pattern, categoryId: row.categoryId, source: row.source }]
          : [],
      );
    },
    /** Sparar en inlärd regel ("Gör alltid så"). Finns regeln redan uppdateras dess kategori. */
    async save(rule: CategoryRule): Promise<void> {
      const values = { id: rule.id, match: rule.match, pattern: rule.pattern, categoryId: rule.categoryId, source: rule.source };
      await db.insert(categoryRules).values(values).onConflictDoUpdate({ target: categoryRules.id, set: { categoryId: rule.categoryId } });
    },
    /** Byter mönster och kategori på en regel. Falskt om den inte finns. */
    async update(rule: Pick<CategoryRule, "id" | "pattern" | "categoryId">): Promise<boolean> {
      const updated = await db
        .update(categoryRules)
        .set({ pattern: rule.pattern, categoryId: rule.categoryId })
        .where(eq(categoryRules.id, rule.id))
        .returning({ id: categoryRules.id })
        .all();
      return updated.length > 0;
    },
    /** Tar bort en regel. Transaktioner den har kategoriserat behåller sin kategori. Falskt om den inte finns. */
    async remove(id: string): Promise<boolean> {
      return (await db.delete(categoryRules).where(eq(categoryRules.id, id)).returning({ id: categoryRules.id }).all()).length > 0;
    },
  };
}
