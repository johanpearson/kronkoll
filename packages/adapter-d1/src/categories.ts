/**
 * Kategorierna i D1 (KK-18-A). Arkiverade tas med, så att äldre transaktioner har ett namn. Reglerna för
 * namn, nivåer och sammanslagning finns i domänen (`domain/categories`); här sparas bara resultatet.
 */
import type { D1Database } from "@cloudflare/workers-types";
import type { CategoryRule } from "@kronkoll/domain";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { categories } from "./schema.ts";

export interface CategoryRow {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly kind: "expense" | "income" | "transfer";
  readonly archived: boolean;
  /** Platsen bland syskonen (#251). Null eller utelämnad: ordnas på namn, efter dem som har en plats. */
  readonly position?: number | null;
}

/** Vad en rensning av alla kategorier berör (KK-48-A). */
export interface ResetSummary {
  readonly categories: number;
  /** Regler som sätter en kategori. Regler som bara sätter inkomsttyp eller Räkna inte rörs inte. */
  readonly rules: number;
  readonly transactions: number;
  readonly splits: number;
  readonly budgetLines: number;
}

/** Mallen som kan sättas tillbaka efter en rensning. */
export interface CategoryTemplate {
  readonly categories: readonly CategoryRow[];
  readonly rules: readonly CategoryRule[];
}

export function categoryRepository(d1: D1Database) {
  const db = drizzle(d1);
  const update = (c: CategoryRow) =>
    db.update(categories).set({ parentId: c.parentId, name: c.name, archived: c.archived, position: c.position ?? null }).where(eq(categories.id, c.id));

  return {
    async list(): Promise<CategoryRow[]> {
      return db
        .select({ id: categories.id, parentId: categories.parentId, name: categories.name, kind: categories.kind, archived: categories.archived, position: categories.position })
        .from(categories)
        .all();
    },

    async insert(category: CategoryRow): Promise<void> {
      await db.insert(categories).values(category);
    },

    /** Sparar ändrat namn, förälder, arkivering och plats för kategorierna, i en batch. */
    async save(changed: readonly CategoryRow[]): Promise<void> {
      const [first, ...rest] = changed.map(update);
      if (first) await db.batch([first, ...rest]);
    },

    /** Hur mycket en rensning av alla kategorier berör, utan att ändra något (KK-48-A). */
    async resetSummary(): Promise<ResetSummary> {
      const count = async (sql: string) => (await d1.prepare(sql).first<{ n: number }>())?.n ?? 0;
      const [categories, rules, transactions, splits, budgetLines] = await Promise.all([
        count(`SELECT count(*) AS n FROM categories`),
        count(`SELECT count(*) AS n FROM category_rules WHERE action = 'categorize' AND category_id IS NOT NULL`),
        count(`SELECT count(*) AS n FROM transactions WHERE category_id IS NOT NULL`),
        count(`SELECT count(*) AS n FROM transaction_splits`),
        count(`SELECT count(*) AS n FROM budget_lines`),
      ]);
      return { categories, rules, transactions, splits, budgetLines };
    },

    /**
     * Rensar alla kategorier i en batch, så att ett fel ändrar ingenting (KK-48-B): transaktionerna blir
     * okategoriserade och uppdelningarna, kategoriserande regler och budgetrader tas bort. Inga transaktioner
     * raderas. Med `template` sätts mallens kategorier och regler tillbaka, annars blir listan tom.
     */
    async reset(template?: CategoryTemplate): Promise<void> {
      const insertCategory = (c: CategoryRow) =>
        d1.prepare(`INSERT INTO categories (id, parent_id, name, kind, archived) VALUES (?, ?, ?, ?, ?)`).bind(c.id, c.parentId, c.name, c.kind, c.archived ? 1 : 0);
      const insertRule = (r: CategoryRule) =>
        d1.prepare(`INSERT INTO category_rules (id, match, pattern, category_id, source) VALUES (?, ?, ?, ?, ?)`).bind(r.id, r.match, r.pattern, r.categoryId, r.source);
      // Huvudkategorierna först, så att underkategorierna har något att peka på.
      const mains = (template?.categories ?? []).filter((c) => c.parentId === null);
      const subs = (template?.categories ?? []).filter((c) => c.parentId !== null);
      await d1.batch([
        d1.prepare(`DELETE FROM transaction_splits`),
        d1.prepare(`UPDATE transactions SET category_id = NULL, category_source = 'none' WHERE category_id IS NOT NULL`),
        d1.prepare(`DELETE FROM category_rules WHERE action = 'categorize' AND category_id IS NOT NULL`),
        d1.prepare(`DELETE FROM budget_lines`),
        d1.prepare(`DELETE FROM categories WHERE parent_id IS NOT NULL`),
        d1.prepare(`DELETE FROM categories`),
        ...mains.map(insertCategory),
        ...subs.map(insertCategory),
        ...(template?.rules ?? []).map(insertRule),
      ]);
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
          d1.prepare(`UPDATE categories SET parent_id = ?, name = ?, archived = ?, position = ? WHERE id = ?`).bind(c.parentId, c.name, c.archived ? 1 : 0, c.position ?? null, c.id),
        ),
      ]);
      return results[0]?.meta.changes ?? 0;
    },
  };
}
