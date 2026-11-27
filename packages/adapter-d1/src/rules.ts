/**
 * Kategoriseringsregler i D1 (KK-18). Mallreglerna kommer från migreringen 0002, inlärda regler
 * från "Gör alltid så". Regler som domänen ännu inte kan använda (beloppsintervall och regler som
 * bara sätter inkomsttyp, KK-22) hoppas över här, så att de aldrig ger fel kategori.
 */
import type { D1Database } from "@cloudflare/workers-types";
import { orderRules, type CategoryRule, type ExcludeRule } from "@kronkoll/domain";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { categoryRules } from "./schema.ts";

const SUPPORTED_MATCH = new Set<string>(["counterparty_exact", "counterparty_prefix", "description_contains"] satisfies CategoryRule["match"][]);

export function ruleRepository(d1: D1Database) {
  const db = drizzle(d1);
  return {
    async list(): Promise<CategoryRule[]> {
      const rows = await db.select().from(categoryRules).where(eq(categoryRules.action, "categorize")).all();
      return rows.flatMap((row): CategoryRule[] =>
        row.categoryId !== null && SUPPORTED_MATCH.has(row.match)
          ? [
              {
                id: row.id,
                match: row.match as CategoryRule["match"],
                pattern: row.pattern,
                categoryId: row.categoryId,
                source: row.source,
                ...(row.source === "learned" && row.position !== null ? { position: row.position } : {}),
              },
            ]
          : [],
      );
    },
    /**
     * Sparar en inlärd regel ("Gör alltid så"). Finns regeln redan uppdateras dess kategori och den behåller sin
     * plats. En ny egen regel hamnar först i användarens ordning (KK-58-C), före den som stod först.
     */
    async save(rule: CategoryRule): Promise<void> {
      const first = sql`(SELECT COALESCE(MIN(${categoryRules.position}), 1) - 1 FROM ${categoryRules})`;
      const values = { id: rule.id, match: rule.match, pattern: rule.pattern, categoryId: rule.categoryId, source: rule.source, position: rule.source === "learned" ? first : null };
      await db.insert(categoryRules).values(values).onConflictDoUpdate({ target: categoryRules.id, set: { categoryId: rule.categoryId } });
    },
    /**
     * Sparar användarens ordning (KK-58-C): de egna kategorireglernas id, den som ska vinna först. Platserna blir
     * 0, 1, 2 … Kastar och ändrar inget om ordningen inte innehåller varje egen regel exakt en gång.
     */
    async setOrder(order: readonly string[]): Promise<void> {
      const rules = orderRules(await this.list(), order);
      const updates = rules.flatMap((r) => (r.position === undefined ? [] : [d1.prepare(`UPDATE category_rules SET position = ? WHERE id = ?`).bind(r.position, r.id)]));
      if (updates.length > 0) await d1.batch(updates);
    },
    /** Byter mönster, kategori och slag av träff på en regel. Falskt om den inte finns. */
    async update(rule: Pick<CategoryRule, "id" | "pattern" | "categoryId"> & Partial<Pick<CategoryRule, "match">>): Promise<boolean> {
      const updated = await db
        .update(categoryRules)
        .set({ pattern: rule.pattern, categoryId: rule.categoryId, ...(rule.match === undefined ? {} : { match: rule.match }) })
        .where(eq(categoryRules.id, rule.id))
        .returning({ id: categoryRules.id })
        .all();
      return updated.length > 0;
    },
    /** Tar bort en regel. Transaktioner den har kategoriserat behåller sin kategori. Falskt om den inte finns. */
    async remove(id: string): Promise<boolean> {
      return (await db.delete(categoryRules).where(eq(categoryRules.id, id)).returning({ id: categoryRules.id }).all()).length > 0;
    },

    /** Hur många regler "Ta bort alla regler" tar bort (KK-51): kategoriserande och Räkna inte. Inkomstregler ingår inte. */
    async countAll(): Promise<{ categorize: number; exclude: number }> {
      const count = async (where: string) => (await d1.prepare(`SELECT count(*) AS n FROM category_rules WHERE ${where}`).first<{ n: number }>())?.n ?? 0;
      return { categorize: await count(`action = 'categorize' AND category_id IS NOT NULL`), exclude: await count(`action = 'exclude'`) };
    },
    /** Tar bort alla kategoriserande regler och alla Räkna inte-regler. Transaktionerna behåller sin kategori. */
    async removeAll(): Promise<void> {
      await d1.prepare(`DELETE FROM category_rules WHERE (action = 'categorize' AND category_id IS NOT NULL) OR action = 'exclude'`).run();
    },

    /** Regler med åtgärden Räkna inte (KK-39-C), i domänens form. */
    async excludeRules(): Promise<ExcludeRule[]> {
      const rows = await db
        .select({ id: categoryRules.id, match: categoryRules.match, pattern: categoryRules.pattern })
        .from(categoryRules)
        .where(eq(categoryRules.action, "exclude"))
        .all();
      return rows.flatMap((row): ExcludeRule[] => (SUPPORTED_MATCH.has(row.match) ? [{ ...row, match: row.match as ExcludeRule["match"] }] : []));
    },
    /** Sparar en Räkna inte-regel. Den har ingen kategori. */
    async saveExclude(rule: ExcludeRule): Promise<void> {
      await db.insert(categoryRules).values({ id: rule.id, match: rule.match, pattern: rule.pattern, categoryId: null, source: "learned", action: "exclude" });
    },
    /** Byter mönster och slag av träff på en Räkna inte-regel. Falskt om den inte finns eller är en kategoriregel. */
    async updateExclude(rule: Pick<ExcludeRule, "id" | "pattern"> & Partial<Pick<ExcludeRule, "match">>): Promise<boolean> {
      const updated = await db
        .update(categoryRules)
        .set({ pattern: rule.pattern, ...(rule.match === undefined ? {} : { match: rule.match }) })
        .where(and(eq(categoryRules.id, rule.id), eq(categoryRules.action, "exclude")))
        .returning({ id: categoryRules.id })
        .all();
      return updated.length > 0;
    },
  };
}
