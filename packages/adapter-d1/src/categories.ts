/** Kategorierna i D1 (KK-18-A). Arkiverade tas med, så att äldre transaktioner har ett namn. */
import type { D1Database } from "@cloudflare/workers-types";
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
  return {
    async list(): Promise<CategoryRow[]> {
      return db
        .select({ id: categories.id, parentId: categories.parentId, name: categories.name, kind: categories.kind, archived: categories.archived })
        .from(categories)
        .all();
    },
  };
}
