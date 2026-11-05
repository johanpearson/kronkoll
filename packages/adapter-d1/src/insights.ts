/**
 * Insikter i D1 (KK-24): utbetalningar över en längre tid, med det som behövs för att känna igen
 * återkommande dragningar i domänen (`recurringCharges`) och visa vem en stor utgift gick till.
 * Datumet är bokföringsdagen, annars köpdagen, som i budgeten.
 */
import type { D1Database } from "@cloudflare/workers-types";
import { and, asc, between, lt, ne, sql } from "drizzle-orm";
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
}

const chargeDate = sql<string>`coalesce(${transactions.bookingDate}, ${transactions.transactionDate})`;

export function insightsRepository(d1: D1Database) {
  const db = drizzle(d1);
  return {
    /** Utbetalningar från och med `from` till och med `to`, äldst först, utan borttagna. */
    async charges(from: string, to: string): Promise<ChargeRow[]> {
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
        })
        .from(transactions)
        .where(and(lt(transactions.amountMinor, 0), ne(transactions.status, "removed"), between(chargeDate, from, to)))
        .orderBy(asc(chargeDate), asc(transactions.id))
        .all();
    },
  };
}
