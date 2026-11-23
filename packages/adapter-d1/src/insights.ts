/**
 * Insikter i D1 (KK-24): utbetalningar över en längre tid, med det som behövs för att känna igen
 * återkommande dragningar i domänen (`recurringCharges`) och visa vem en stor utgift gick till.
 * Datumet är bokföringsdagen, annars köpdagen, som i budgeten.
 */
import type { D1Database } from "@cloudflare/workers-types";
import { and, asc, between, inArray, lt, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { transactions } from "./schema.ts";

export interface ChargeRow {
  readonly id: string;
  readonly date: string;
  readonly amountMinor: number;
  readonly counterparty: string;
  readonly counterpartyNorm: string;
  readonly description: string;
  readonly status: "pending" | "booked" | "removed";
  readonly internal: boolean;
  /** Kategorin, för att veta vilken kategori en återkommande dragning hör till (KK-42). */
  readonly categoryId: string | null;
}

const chargeDate = sql<string>`coalesce(${transactions.bookingDate}, ${transactions.transactionDate})`;

export function insightsRepository(d1: D1Database) {
  const db = drizzle(d1);
  return {
    /** Utbetalningar från och med `from` till och med `to`, äldst först, utan borttagna. Bara `accountIds` om de anges (KK-41-C). */
    async charges(from: string, to: string, accountIds?: readonly string[]): Promise<ChargeRow[]> {
      return db
        .select({
          id: transactions.id,
          date: chargeDate,
          amountMinor: transactions.amountMinor,
          counterparty: transactions.counterparty,
          counterpartyNorm: transactions.counterpartyNorm,
          description: transactions.description,
          status: transactions.status,
          internal: transactions.isInternalTransfer,
          categoryId: transactions.categoryId,
        })
        .from(transactions)
        .where(and(lt(transactions.amountMinor, 0), ne(transactions.status, "removed"),
            between(chargeDate, from, to),
            accountIds === undefined ? undefined : inArray(transactions.accountId, [...accountIds]),
          ),
        )
        .orderBy(asc(chargeDate), asc(transactions.id))
        .all();
    },
  };
}
