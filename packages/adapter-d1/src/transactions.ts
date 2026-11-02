/**
 * Transaktioner i D1 för synken (KK-9, KK-7-A). Läser det som `reconcile` behöver och sparar dess
 * resultat i en batch, så att en synk av ett konto antingen skrivs helt eller inte alls.
 *
 * Bankens motparts- och beskrivningstext är opålitlig indata (KK-30) och sparas som text. Kategori,
 * uppdelning och överföringsmarkering hör till senare steg och rörs aldrig av en uppdatering härifrån.
 *
 * `last_seen_at` innehåller den svenska kalenderdagen då banken senast levererade raden
 * (StoredTransaction.lastSeenOn), inte ett klockslag: reconcile räknar bara i dagar.
 */
import type { D1Database } from "@cloudflare/workers-types";
import { addDays, MATCH_WINDOW_DAYS, type ReconcileResult, type StoredTransaction } from "@kronkoll/domain";
import { and, eq, gte, inArray, max, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { transactions } from "./schema.ts";

type Row = typeof transactions.$inferSelect;

function toStored(row: Row): StoredTransaction {
  return {
    id: row.id,
    accountId: row.accountId,
    providerTxId: row.providerTxId,
    status: row.status,
    transactionDate: row.transactionDate,
    bookingDate: row.bookingDate,
    amountMinor: row.amountMinor,
    counterpartyNorm: row.counterpartyNorm,
    counterparty: row.counterparty,
    description: row.description,
    lastSeenOn: row.lastSeenAt,
  };
}

/** Kolumnerna som en synk äger. Allt annat (kategori m.m.) lämnas orört vid uppdatering. */
function toSyncColumns(tx: StoredTransaction) {
  return {
    accountId: tx.accountId,
    providerTxId: tx.providerTxId,
    // Förenklat fingeravtryck för indexet. Själva matchningen görs i domänen.
    fingerprint: `${String(tx.amountMinor)}|${tx.counterpartyNorm}`,
    status: tx.status,
    lastSeenAt: tx.lastSeenOn,
    transactionDate: tx.transactionDate,
    bookingDate: tx.bookingDate,
    amountMinor: tx.amountMinor,
    counterparty: tx.counterparty,
    counterpartyNorm: tx.counterpartyNorm,
    description: tx.description,
  };
}

export function transactionRepository(d1: D1Database) {
  const db = drizzle(d1);
  return {
    /**
     * Raderna som `reconcile` kan behöva matcha mot: de från och med datumgränsen minus
     * matchningsfönstret, och alla preliminära (de kan ha försvunnit när som helst). Utan
     * datumgräns, första gången, läses allt för kontona.
     */
    async forReconcile(accountIds: readonly string[], dateFrom: string | null): Promise<StoredTransaction[]> {
      if (accountIds.length === 0) return [];
      const inAccounts = inArray(transactions.accountId, [...accountIds]);
      const where =
        dateFrom === null
          ? inAccounts
          : and(inAccounts, or(eq(transactions.status, "pending"), gte(transactions.transactionDate, addDays(dateFrom, -MATCH_WINDOW_DAYS))));
      return (await db.select().from(transactions).where(where).all()).map(toStored);
    },

    /** Sparar nya och ändrade rader i en batch. Ett fel rullar tillbaka alltihop. */
    async save(result: ReconcileResult): Promise<void> {
      const statements = [
        ...result.inserted.map((tx) => db.insert(transactions).values({ id: tx.id, ...toSyncColumns(tx) })),
        ...result.updated.map((tx) => db.update(transactions).set(toSyncColumns(tx)).where(eq(transactions.id, tx.id))),
      ];
      const [first, ...rest] = statements;
      if (first) await db.batch([first, ...rest]);
    },

    /** Bokföringsdagen för kontots senaste bokförda transaktion, underlag för `syncDateFrom`. */
    async latestBookedDate(accountId: string): Promise<string | null> {
      const row = await db
        .select({ latest: max(transactions.bookingDate) })
        .from(transactions)
        .where(and(eq(transactions.accountId, accountId), eq(transactions.status, "booked")))
        .get();
      return row?.latest ?? null;
    },
  };
}
