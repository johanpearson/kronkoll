/**
 * Inkomstklassning i D1 (KK-22, #40). Klassningen räknas i domänen (`classifyIncome`, `applyIncomeRules`).
 * Inkomstregler är rader i `category_rules` som sätter inkomsttyp men ingen kategori. Mallreglerna kommer
 * från migreringen 0011, inlärda regler från en manuell ändring.
 */
import type { D1Database } from "@cloudflare/workers-types";
import type { IncomeChange, IncomeRule, IncomeTransaction, IncomeType } from "@kronkoll/domain";
import { and, between, eq, gt, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { categoryRules, transactions } from "./schema.ts";

const SUPPORTED_MATCH = new Set<string>(["counterparty_exact", "counterparty_prefix", "description_contains"] satisfies IncomeRule["match"][]);

export interface IncomeMonth {
  /** ÅÅÅÅ-MM. */
  readonly month: string;
  readonly salaryMinor: number;
  readonly parentalBenefitMinor: number;
  readonly otherMinor: number;
}

/** Dagen som räknas för en transaktion: bokföringsdag, annars köpdag. */
const day = sql<string>`coalesce(${transactions.bookingDate}, ${transactions.transactionDate})`;
const sumOf = (type: IncomeType | null) =>
  sql<number>`coalesce(sum(CASE WHEN ${type === null ? sql`${transactions.incomeType} IS NULL OR ${transactions.incomeType} = 'other'` : sql`${transactions.incomeType} = ${type}`} THEN ${transactions.amountMinor} ELSE 0 END), 0)`;

export function incomeRepository(d1: D1Database) {
  const db = drizzle(d1);
  const incoming = and(gt(transactions.amountMinor, 0), ne(transactions.status, "removed"));
  return {
    /** Regler som sätter inkomsttyp, i domänens form. */
    async rules(): Promise<IncomeRule[]> {
      const rows = await db
        .select({
          id: categoryRules.id,
          match: categoryRules.match,
          pattern: categoryRules.pattern,
          // Frågan tar bara med rader som har en inkomsttyp.
          incomeType: sql<IncomeType>`${categoryRules.incomeType}`,
          source: categoryRules.source,
        })
        .from(categoryRules)
        .where(and(eq(categoryRules.action, "categorize"), isNull(categoryRules.categoryId), isNotNull(categoryRules.incomeType)))
        .all();
      return rows.flatMap((row): IncomeRule[] => (SUPPORTED_MATCH.has(row.match) ? [{ ...row, match: row.match as IncomeRule["match"] }] : []));
    },

    /** Sparar en inlärd inkomstregel. Finns regeln redan uppdateras dess inkomsttyp. */
    async saveRule(rule: IncomeRule): Promise<void> {
      const values = { id: rule.id, match: rule.match, pattern: rule.pattern, incomeType: rule.incomeType, source: rule.source };
      await db.insert(categoryRules).values(values).onConflictDoUpdate({ target: categoryRules.id, set: { incomeType: rule.incomeType } });
    },

    /** Alla inbetalningar som inte är borttagna, för att klassas. */
    async incoming(): Promise<IncomeTransaction[]> {
      return db
        .select({
          id: transactions.id,
          amountMinor: transactions.amountMinor,
          counterpartyNorm: transactions.counterpartyNorm,
          description: transactions.description,
          incomeType: transactions.incomeType,
          incomeSource: transactions.incomeSource,
        })
        .from(transactions)
        .where(incoming)
        .all();
    },

    /** Sparar klassningar i en batch. En manuell klassning skrivs bara över av en ny manuell (KK-22-A). */
    async setIncome(changes: readonly IncomeChange[]): Promise<void> {
      const statements = changes.map((change) =>
        db
          .update(transactions)
          .set({ incomeType: change.incomeType, incomeSource: change.incomeSource })
          .where(and(eq(transactions.id, change.id), change.incomeSource === "manual" ? undefined : ne(transactions.incomeSource, "manual"))),
      );
      const [first, ...rest] = statements;
      if (first) await db.batch([first, ...rest]);
    },

    /**
     * Inkomst per kalendermånad och typ från och med `from` till och med `to` (ÅÅÅÅ-MM), för KK-22-B.
     * Interna överföringar räknas inte. En inbetalning som ännu inte är klassad räknas som övrigt.
     * Månader utan inkomst saknas.
     */
    async monthly(from: string, to: string): Promise<IncomeMonth[]> {
      const month = sql<string>`substr(${day}, 1, 7)`;
      return db
        .select({ month, salaryMinor: sumOf("salary"), parentalBenefitMinor: sumOf("parental_benefit"), otherMinor: sumOf(null) })
        .from(transactions)
        .where(and(incoming, eq(transactions.isInternalTransfer, false), between(month, from, to)))
        .groupBy(month)
        .orderBy(month)
        .all();
    },
  };
}
