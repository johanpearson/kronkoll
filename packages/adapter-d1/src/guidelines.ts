/**
 * Engångsperioder i D1 (KK-42-E): perioder som lämnas utanför normalnivån i budgetplaneraren. Listan gäller
 * tills vidare och ersätts som en helhet i en batch, så ett fel ändrar ingenting.
 */
import type { D1Database } from "@cloudflare/workers-types";
import { asc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { guidelineOneOffPeriods } from "./schema.ts";

export interface GuidelineState {
  /** Periodnycklar ÅÅÅÅ-MM, sorterade. */
  readonly oneOffPeriods: readonly string[];
}

export function guidelineRepository(d1: D1Database) {
  const db = drizzle(d1);
  return {
    async get(): Promise<GuidelineState> {
      const oneOffs = await db.select().from(guidelineOneOffPeriods).orderBy(asc(guidelineOneOffPeriods.period)).all();
      return { oneOffPeriods: oneOffs.map((o) => o.period) };
    },

    /** Ersätter listan i en batch. En felaktig period ger ett fel utan ändring. */
    async save(state: GuidelineState): Promise<void> {
      await db.batch([db.delete(guidelineOneOffPeriods), ...state.oneOffPeriods.map((period) => db.insert(guidelineOneOffPeriods).values({ period }))]);
    },
  };
}
