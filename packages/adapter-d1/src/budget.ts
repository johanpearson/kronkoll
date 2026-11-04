/**
 * Budget i D1 (KK-20, KK-34): budgetrader per period och det som behövs för att räkna utfallet i
 * domänen (`budgetOutcome`). En transaktion hör till den period där den bokfördes, eller köptes om
 * den ännu inte är bokförd, precis som `BudgetTransaction.date` beskriver.
 */
import type { D1Database } from "@cloudflare/workers-types";
import type { BudgetLineInput, BudgetPeriod, BudgetTransaction, SplitPart } from "@kronkoll/domain";
import { and, asc, between, eq, inArray, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { budgetLines, transactionSplits, transactions } from "./schema.ts";

export type BudgetSource = (typeof budgetLines.$inferSelect)["source"];

/** Dagen som avgör perioden: bokföringsdag, annars köpdag. */
const budgetDate = sql<string>`coalesce(${transactions.bookingDate}, ${transactions.transactionDate})`;

export function budgetRepository(d1: D1Database) {
  const db = drizzle(d1);
  const inPeriod = (period: BudgetPeriod) => and(ne(transactions.status, "removed"), between(budgetDate, period.start, period.end));

  return {
    /** Periodens transaktioner och deras uppdelningar, i domänens form. */
    async actuals(period: BudgetPeriod): Promise<{ transactions: BudgetTransaction[]; splits: Map<string, SplitPart[]> }> {
      const rows = await db
        .select({
          id: transactions.id,
          date: budgetDate,
          amountMinor: transactions.amountMinor,
          categoryId: transactions.categoryId,
          status: transactions.status,
          internal: transactions.isInternalTransfer,
        })
        .from(transactions)
        .where(inPeriod(period))
        .all();
      // Underfråga i stället för en lista med id:n, eftersom D1 tillåter högst 100 parametrar per fråga.
      const parts = await db
        .select({ transactionId: transactionSplits.transactionId, categoryId: transactionSplits.categoryId, amountMinor: transactionSplits.amountMinor })
        .from(transactionSplits)
        .where(inArray(transactionSplits.transactionId, db.select({ id: transactions.id }).from(transactions).where(inPeriod(period))))
        .orderBy(asc(sql`${transactionSplits}.rowid`))
        .all();
      const splits = new Map<string, SplitPart[]>();
      for (const part of parts) splits.set(part.transactionId, [...(splits.get(part.transactionId) ?? []), { categoryId: part.categoryId, amountMinor: part.amountMinor }]);
      return { transactions: rows, splits };
    },

    async lines(periodKey: string): Promise<BudgetLineInput[]> {
      return db
        .select({ categoryId: budgetLines.categoryId, amountMinor: budgetLines.amountMinor })
        .from(budgetLines)
        .where(eq(budgetLines.period, periodKey))
        .orderBy(asc(budgetLines.categoryId))
        .all();
    },

    /** Ersätter periodens budget i en batch. Ett fel (okänd kategori, negativt belopp) ändrar ingenting. */
    async replace(periodKey: string, lines: readonly BudgetLineInput[], source: BudgetSource): Promise<void> {
      await db.batch([
        db.delete(budgetLines).where(eq(budgetLines.period, periodKey)),
        ...lines.map((line) => db.insert(budgetLines).values({ period: periodKey, categoryId: line.categoryId, amountMinor: line.amountMinor, source })),
      ]);
    },

    /** Tar bort hela periodens budget (KK-40). Transaktioner och andra perioder rörs inte. */
    async remove(periodKey: string): Promise<void> {
      await db.delete(budgetLines).where(eq(budgetLines.period, periodKey)).run();
    },
  };
}
