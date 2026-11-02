/**
 * Uppdelningar i D1 (KK-19). Att delarna summerar exakt till beloppet kontrolleras i domänen
 * (`validateSplit`) innan något sparas här. Ett byte sker i en batch: de gamla delarna tas bort och
 * de nya läggs in tillsammans, så en halv uppdelning kan aldrig bli kvar.
 */
import type { D1Database } from "@cloudflare/workers-types";
import type { SplitPart } from "@kronkoll/domain";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { transactionSplits, transactions } from "./schema.ts";

export function splitRepository(d1: D1Database) {
  const db = drizzle(d1);
  return {
    /** Beloppet för en transaktion som går att dela upp, eller null om den saknas eller är borttagen. */
    async amountOf(transactionId: string): Promise<number | null> {
      const [row] = await db
        .select({ amountMinor: transactions.amountMinor })
        .from(transactions)
        .where(and(eq(transactions.id, transactionId), ne(transactions.status, "removed")))
        .all();
      return row?.amountMinor ?? null;
    },

    /** Delarna i den ordning de sparades. Tom lista om transaktionen inte är uppdelad. */
    async get(transactionId: string): Promise<SplitPart[]> {
      return db
        .select({ categoryId: transactionSplits.categoryId, amountMinor: transactionSplits.amountMinor })
        .from(transactionSplits)
        .where(eq(transactionSplits.transactionId, transactionId))
        .orderBy(asc(sql`rowid`))
        .all();
    },

    /** Ersätter uppdelningen. En tom lista tar bort den. */
    async replace(transactionId: string, parts: readonly SplitPart[], newId: () => string): Promise<void> {
      await db.batch([
        db.delete(transactionSplits).where(eq(transactionSplits.transactionId, transactionId)),
        ...parts.map((part) => db.insert(transactionSplits).values({ id: newId(), transactionId, categoryId: part.categoryId, amountMinor: part.amountMinor })),
      ]);
    },
  };
}
