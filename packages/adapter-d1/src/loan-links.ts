/**
 * Kopplingen mellan betalningar och lån i D1 (KK-59). Matchningen görs i domänen (`linkLoans`); här sparas
 * lånens matchningstexter och kategori, och kopplingarna skrivs.
 *
 * En kopplad betalning får lånets kategori och vinner över reglerna, men aldrig över en manuell kategori
 * (ägarens beslut 2026-11-28). Kategorin sparas som "learned", som en egen regel, och kategoriseringen hoppar
 * över kopplade transaktioner (`uncategorized` och `categorizable` i transactions.ts). Tas en automatisk
 * koppling bort släpps kategorin, så att reglerna sätter den igen.
 */
import type { D1Database } from "@cloudflare/workers-types";
import type { LoanLinkChange, LoanMatcher, LoanTransaction } from "@kronkoll/domain";
import { and, asc, eq, gte, isNotNull, lt, ne, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { loans, transactions } from "./schema.ts";

export interface LoanMatching extends LoanMatcher {
  readonly categoryId: string | null;
}

/** Matchningstexterna ur kolumnen. En trasig lista räknas som ingen, så att synken aldrig stoppas av den. */
function parsePatterns(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

const bookedOrBought = sql<string>`coalesce(${transactions.bookingDate}, ${transactions.transactionDate})`;

export function loanLinkRepository(d1: D1Database) {
  const db = drizzle(d1);
  return {
    /** Varje låns matchningstexter och kategori, i den ordning lånen lades till. */
    async matchers(): Promise<LoanMatching[]> {
      const rows = await db
        .select({ loanId: loans.id, patterns: loans.matchPatterns, categoryId: loans.categoryId })
        .from(loans)
        .orderBy(asc(loans.createdAt), asc(loans.id))
        .all();
      return rows.map((r) => ({ loanId: r.loanId, patterns: parsePatterns(r.patterns), categoryId: r.categoryId }));
    },

    /** Sparar lånets matchningstexter och kategori (KK-59-A). Falskt om lånet inte finns. */
    async setMatching(loanId: string, patterns: readonly string[], categoryId: string | null): Promise<boolean> {
      const updated = await db
        .update(loans)
        .set({ matchPatterns: JSON.stringify(patterns), categoryId })
        .where(eq(loans.id, loanId))
        .returning({ id: loans.id })
        .all();
      return updated.length > 0;
    },

    /**
     * Utbetalningar som kan vara lånebetalningar, från och med ett datum (null för all historik), plus alla som
     * redan är kopplade, så att en koppling som inte längre stämmer kan tas bort.
     */
    async candidates(since: string | null): Promise<LoanTransaction[]> {
      const recent = and(lt(transactions.amountMinor, 0), since === null ? undefined : gte(bookedOrBought, since));
      return db
        .select({
          id: transactions.id,
          date: bookedOrBought,
          status: transactions.status,
          amountMinor: transactions.amountMinor,
          counterparty: transactions.counterparty,
          description: transactions.description,
          loanId: transactions.loanId,
          loanSource: transactions.loanSource,
        })
        .from(transactions)
        .where(and(ne(transactions.status, "removed"), or(recent, isNotNull(transactions.loanId))))
        .all();
    },

    /** Betalningar som är kopplade till något lån, med datum i perioden, för Betalt denna period (KK-59-C). */
    async payments(from: string, to: string): Promise<LoanTransaction[]> {
      return db
        .select({
          id: transactions.id,
          date: bookedOrBought,
          status: transactions.status,
          amountMinor: transactions.amountMinor,
          counterparty: transactions.counterparty,
          description: transactions.description,
          loanId: transactions.loanId,
          loanSource: transactions.loanSource,
        })
        .from(transactions)
        .where(and(isNotNull(transactions.loanId), ne(transactions.status, "removed"), sql`${bookedOrBought} BETWEEN ${from} AND ${to}`))
        .all();
    },

    /**
     * Skriver kopplingarna från `linkLoans`. En ny koppling ger lånets kategori om lånet har en och kategorin inte är
     * manuell. En borttagen automatisk koppling släpper kategorin från lånet. Manuella kopplingar rörs aldrig.
     */
    /**
     * Kopplar en betalning till ett lån för hand, eller tar bort kopplingen med null (KK-59-B). Kopplingen blir
     * manuell, så att matchningen aldrig ändrar den. Lånets kategori sätts eller släpps som när matchningen gör det,
     * men en manuell kategori rörs aldrig. Falskt om transaktionen eller lånet inte finns.
     */
    async setManual(transactionId: string, loanId: string | null): Promise<boolean> {
      const [tx] = await db
        .select({ loanId: transactions.loanId })
        .from(transactions)
        .where(and(eq(transactions.id, transactionId), ne(transactions.status, "removed")))
        .all();
      const [loan] = loanId === null ? [] : await db.select({ categoryId: loans.categoryId }).from(loans).where(eq(loans.id, loanId)).all();
      if (!tx || (loanId !== null && !loan)) return false;
      const row = eq(transactions.id, transactionId);
      const notManualCategory = and(row, ne(transactions.categorySource, "manual"));
      const categoryId = loan?.categoryId ?? null;
      const category =
        loanId === null
          ? tx.loanId === null
            ? []
            : [db.update(transactions).set({ categoryId: null, categorySource: "none" }).where(notManualCategory)]
          : categoryId === null
            ? []
            : [db.update(transactions).set({ categoryId, categorySource: "learned" }).where(notManualCategory)];
      // Kategorin beror bara på kopplingen före ändringen, som lästes ovan, så ordningen spelar ingen roll.
      await db.batch([db.update(transactions).set({ loanId, loanSource: "manual" }).where(row), ...category]);
      return true;
    },

    async apply(changes: readonly LoanLinkChange[], matching: readonly LoanMatching[]): Promise<void> {
      const categoryOf = new Map(matching.map((m) => [m.loanId, m.categoryId]));
      const notManualLink = or(sql`${transactions.loanSource} IS NULL`, eq(transactions.loanSource, "auto"));
      const statements = changes.flatMap((change) => {
        const row = and(eq(transactions.id, change.id), notManualLink);
        const notManualCategory = and(row, ne(transactions.categorySource, "manual"));
        if (change.loanId === null) {
          return [
            db.update(transactions).set({ categoryId: null, categorySource: "none" }).where(and(notManualCategory, isNotNull(transactions.loanId))),
            db.update(transactions).set({ loanId: null, loanSource: null }).where(row),
          ];
        }
        const categoryId = categoryOf.get(change.loanId) ?? null;
        return [
          ...(categoryId === null ? [] : [db.update(transactions).set({ categoryId, categorySource: "learned" }).where(notManualCategory)]),
          db.update(transactions).set({ loanId: change.loanId, loanSource: "auto" }).where(row),
        ];
      });
      const [first, ...rest] = statements;
      if (first) await db.batch([first, ...rest]);
    },
  };
}
