/**
 * Lån i D1 (KK-36, #72). Månadskostnaden räknas i domänen (`loanMonthly`); här sparas bara det som
 * läggs in för hand. `save` lägger till eller ändrar ett lån med samma id.
 */
import type { D1Database } from "@cloudflare/workers-types";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { loans } from "./schema.ts";

export interface LoanRecord {
  readonly id: string;
  readonly name: string;
  readonly lender: string | null;
  readonly balanceMinor: number;
  readonly interestRateBp: number;
  readonly rateFixedUntil: string | null;
  readonly amortizationMinor: number;
}

const columns = {
  id: loans.id,
  name: loans.name,
  lender: loans.lender,
  balanceMinor: loans.balanceMinor,
  interestRateBp: loans.interestRateBp,
  rateFixedUntil: loans.rateFixedUntil,
  amortizationMinor: loans.amortizationMinor,
};

export function loanRepository(d1: D1Database) {
  const db = drizzle(d1);
  return {
    /** Alla lån i den ordning de lades till. */
    async list(): Promise<LoanRecord[]> {
      return db.select(columns).from(loans).orderBy(asc(loans.createdAt), asc(loans.id)).all();
    },

    /** Lägger till lånet, eller ändrar det om id:t redan finns. Sant om det var nytt. */
    async save(loan: LoanRecord): Promise<boolean> {
      const { id, ...fields } = loan;
      const existing = await db.select({ id: loans.id }).from(loans).where(eq(loans.id, id)).all();
      await db.insert(loans).values(loan).onConflictDoUpdate({ target: loans.id, set: fields }).run();
      return existing.length === 0;
    },

    /** Falskt om lånet inte finns. */
    async remove(id: string): Promise<boolean> {
      const result = await d1.prepare(`DELETE FROM loans WHERE id = ?`).bind(id).run();
      return result.meta.changes > 0;
    },
  };
}
