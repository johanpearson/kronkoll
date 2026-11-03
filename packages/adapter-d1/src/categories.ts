/**
 * Kategorierna i D1 (KK-18-A). Arkiverade tas med, så att äldre transaktioner har ett namn. Reglerna för
 * namn, nivåer och sammanslagning finns i domänen (`domain/categories`); här sparas bara resultatet.
 */
import type { D1Database } from "@cloudflare/workers-types";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { categories } from "./schema.ts";

export interface CategoryRow {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly kind: "expense" | "income" | "transfer";
  readonly archived: boolean;
}

export function categoryRepository(d1: D1Database) {
  const db = drizzle(d1);
  const update = (c: CategoryRow) =>
    db.update(categories).set({ parentId: c.parentId, name: c.name, archived: c.archived }).where(eq(categories.id, c.id));

  return {
    async list(): Promise<CategoryRow[]> {
      return db
        .select({ id: categories.id, parentId: categories.parentId, name: categories.name, kind: categories.kind, archived: categories.archived })
        .from(categories)
        .all();
    },

    async insert(category: CategoryRow): Promise<void> {
      await db.insert(categories).values(category);
    },

    /** Sparar ändrat namn, förälder och arkivering för kategorierna, i en batch. */
    async save(changed: readonly CategoryRow[]): Promise<void> {
      const [first, ...rest] = changed.map(update);
      if (first) await db.batch([first, ...rest]);
    },

    /**
     * Slår ihop `fromId` med `intoId` i en batch: transaktioner, uppdelningar, regler och budgetrader
     * flyttas. Har båda en budget för samma period läggs beloppen ihop. `changed` är kategorierna som
     * domänen ändrade (den gamla arkiverad, dess underkategorier flyttade). Returnerar antalet
     * transaktioner som flyttades.
     */
    async merge(fromId: string, intoId: string, changed: readonly CategoryRow[]): Promise<number> {
      const move = (table: string) => d1.prepare(`UPDATE ${table} SET category_id = ?2 WHERE category_id = ?1`).bind(fromId, intoId);
      const results = await d1.batch([
        move("transactions"),
        move("transaction_splits"),
        move("category_rules"),
        d1
          .prepare(
            `UPDATE budget_lines SET amount_minor = amount_minor + (SELECT b.amount_minor FROM budget_lines b WHERE b.period = budget_lines.period AND b.category_id = ?1)
             WHERE category_id = ?2 AND period IN (SELECT period FROM budget_lines WHERE category_id = ?1)`,
          )
          .bind(fromId, intoId),
        d1.prepare(`UPDATE budget_lines SET category_id = ?2 WHERE category_id = ?1 AND period NOT IN (SELECT period FROM budget_lines WHERE category_id = ?2)`).bind(fromId, intoId),
        d1.prepare(`DELETE FROM budget_lines WHERE category_id = ?1`).bind(fromId),
        ...changed.map((c) =>
          d1.prepare(`UPDATE categories SET parent_id = ?, name = ?, archived = ? WHERE id = ?`).bind(c.parentId, c.name, c.archived ? 1 : 0, c.id),
        ),
      ]);
      return results[0]?.meta.changes ?? 0;
    },
  };
}
