/**
 * Riktlinjer och sparläge i D1 (KK-42): läge och sparmål (en rad), manuella nivåer per kategori och
 * engångsperioder. Allt gäller tills vidare och sparas som en helhet i en batch, så ett fel ändrar
 * ingenting. Utan sparade val är läget ingen budget.
 */
import type { D1Database } from "@cloudflare/workers-types";
import { asc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { guidelineOneOffPeriods, guidelineOverrides, guidelineSettings } from "./schema.ts";

export type GuidelineMode = (typeof guidelineSettings.$inferSelect)["mode"];

export interface GuidelineOverride {
  readonly categoryId: string;
  readonly amountMinor: number;
}

export interface GuidelineState {
  readonly mode: GuidelineMode;
  readonly savingGoalMinor: number;
  /** Sorterade på kategori-id. */
  readonly overrides: readonly GuidelineOverride[];
  /** Periodnycklar ÅÅÅÅ-MM, sorterade. */
  readonly oneOffPeriods: readonly string[];
}

export function guidelineRepository(d1: D1Database) {
  const db = drizzle(d1);
  return {
    async get(): Promise<GuidelineState> {
      const [row, overrides, oneOffs] = await Promise.all([
        db.select().from(guidelineSettings).get(),
        db.select().from(guidelineOverrides).orderBy(asc(guidelineOverrides.categoryId)).all(),
        db.select().from(guidelineOneOffPeriods).orderBy(asc(guidelineOneOffPeriods.period)).all(),
      ]);
      return {
        mode: row?.mode ?? "none",
        savingGoalMinor: row?.savingGoalMinor ?? 0,
        overrides: overrides.map((o) => ({ categoryId: o.categoryId, amountMinor: o.amountMinor })),
        oneOffPeriods: oneOffs.map((o) => o.period),
      };
    },

    /** Ersätter allt i en batch. Okänd kategori, negativt belopp eller felaktig period ger ett fel utan ändring. */
    async save(state: GuidelineState): Promise<void> {
      await db.batch([
        db
          .insert(guidelineSettings)
          .values({ mode: state.mode, savingGoalMinor: state.savingGoalMinor })
          .onConflictDoUpdate({ target: guidelineSettings.id, set: { mode: state.mode, savingGoalMinor: state.savingGoalMinor } }),
        db.delete(guidelineOverrides),
        ...state.overrides.map((o) => db.insert(guidelineOverrides).values({ categoryId: o.categoryId, amountMinor: o.amountMinor })),
        db.delete(guidelineOneOffPeriods),
        ...state.oneOffPeriods.map((period) => db.insert(guidelineOneOffPeriods).values({ period })),
      ]);
    },
  };
}
