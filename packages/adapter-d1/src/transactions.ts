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
import {
  addDays,
  MATCH_WINDOW_DAYS,
  type CategorizableTransaction,
  type CategoryChange,
  type ReconcileResult,
  type StoredTransaction,
} from "@kronkoll/domain";
import { and, desc, eq, gte, inArray, isNull, lt, lte, max, ne, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { transactions } from "./schema.ts";

type Row = typeof transactions.$inferSelect;

export interface TransactionListQuery {
  /** Första och sista dagen, båda inräknade. */
  readonly from: string;
  readonly to: string;
  readonly limit: number;
  readonly categoryId?: string | undefined;
  readonly uncategorized?: boolean | undefined;
  /** Fritext i motpart och beskrivning. */
  readonly q?: string | undefined;
  /** Från förra sidans `nextCursor`, eller null för första sidan. */
  readonly cursor?: string | null | undefined;
}

export interface TransactionListItem {
  readonly id: string;
  readonly accountId: string;
  readonly status: "pending" | "booked";
  readonly transactionDate: string;
  readonly bookingDate: string | null;
  readonly amountMinor: number;
  /** Bankens text. Opålitlig indata som alltid visas som text (KK-30). */
  readonly counterparty: string;
  readonly description: string;
  readonly categoryId: string | null;
  readonly categorySource: Row["categorySource"];
  readonly isInternalTransfer: boolean;
  /** Transaktionen är uppdelad på flera kategorier (KK-19). */
  readonly split: boolean;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

/** Cursorn är opak för anroparen: datum och id för sista raden på förra sidan. */
function encodeCursor(item: TransactionListItem): string {
  return btoa(JSON.stringify({ d: item.transactionDate, id: item.id })).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeCursor(cursor: string): { d: string; id: string } {
  try {
    const value: unknown = JSON.parse(atob(cursor.replaceAll("-", "+").replaceAll("_", "/")));
    if (typeof value === "object" && value !== null && "d" in value && "id" in value) {
      const { d, id } = value;
      if (typeof d === "string" && ISO_DATE.test(d) && typeof id === "string" && id !== "") return { d, id };
    }
  } catch {
    // Hanteras nedan
  }
  throw new RangeError("Ogiltig cursor");
}

/** % och _ ska sökas som vanliga tecken i LIKE. */
const likePattern = (text: string) => `%${text.replace(/[\\%_]/gu, (c) => `\\${c}`)}%`;

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

    /**
     * Transaktioner för listvyn (#32), nyast först. Borttagna preliminära visas inte. Sidorna
     * bläddras med en cursor på datum och id, så att nya rader inte flyttar om tidigare sidor.
     */
    async list(query: TransactionListQuery): Promise<{ items: TransactionListItem[]; nextCursor: string | null }> {
      const after = query.cursor === undefined || query.cursor === null ? null : decodeCursor(query.cursor);
      const q = query.q?.trim() ?? "";
      const conditions = [
        ne(transactions.status, "removed"),
        gte(transactions.transactionDate, query.from),
        lte(transactions.transactionDate, query.to),
        query.uncategorized ? isNull(transactions.categoryId) : undefined,
        query.categoryId === undefined ? undefined : eq(transactions.categoryId, query.categoryId),
        q === ""
          ? undefined
          : or(
              sql`${transactions.counterparty} LIKE ${likePattern(q)} ESCAPE '\\'`,
              sql`${transactions.counterpartyNorm} LIKE ${likePattern(q.toLocaleUpperCase("sv-SE"))} ESCAPE '\\'`,
              sql`${transactions.description} LIKE ${likePattern(q)} ESCAPE '\\'`,
            ),
        after === null
          ? undefined
          : or(lt(transactions.transactionDate, after.d), and(eq(transactions.transactionDate, after.d), lt(transactions.id, after.id))),
      ];
      const rows = await db
        .select({
          id: transactions.id,
          accountId: transactions.accountId,
          status: transactions.status,
          transactionDate: transactions.transactionDate,
          bookingDate: transactions.bookingDate,
          amountMinor: transactions.amountMinor,
          counterparty: transactions.counterparty,
          description: transactions.description,
          categoryId: transactions.categoryId,
          categorySource: transactions.categorySource,
          isInternalTransfer: transactions.isInternalTransfer,
          // Tabellnamnet behövs: utan det betyder "id" uppdelningens id inne i underfrågan.
          split: sql<number>`EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id = "transactions"."id")`,
        })
        .from(transactions)
        .where(and(...conditions))
        .orderBy(desc(transactions.transactionDate), desc(transactions.id))
        // En rad extra visar om det finns en nästa sida, så att sista sidan aldrig blir tom.
        .limit(query.limit + 1)
        .all();
      const items = rows
        .slice(0, query.limit)
        .map((row): TransactionListItem => ({ ...row, status: row.status === "pending" ? "pending" : "booked", split: Boolean(row.split) }));
      const last = items.at(-1);
      return { items, nextCursor: rows.length > query.limit && last ? encodeCursor(last) : null };
    },

    /**
     * Transaktioner som ännu saknar kategori, för att kategoriseras efter en synk (KK-18).
     * Manuella och redan kategoriserade rörs inte: en ny regel gäller bakåt bara när användaren
     * väljer det.
     */
    async uncategorized(): Promise<CategorizableTransaction[]> {
      return db
        .select({
          id: transactions.id,
          counterpartyNorm: transactions.counterpartyNorm,
          description: transactions.description,
          categoryId: transactions.categoryId,
          categorySource: transactions.categorySource,
        })
        .from(transactions)
        .where(and(eq(transactions.categorySource, "none"), ne(transactions.status, "removed")))
        .all();
    },

    /** En transaktion i domänens form för kategorisering, eller null om den inte finns eller är borttagen. */
    async get(id: string): Promise<CategorizableTransaction | null> {
      const [row] = await db
        .select({
          id: transactions.id,
          counterpartyNorm: transactions.counterpartyNorm,
          description: transactions.description,
          categoryId: transactions.categoryId,
          categorySource: transactions.categorySource,
        })
        .from(transactions)
        .where(and(eq(transactions.id, id), ne(transactions.status, "removed")))
        .all();
      return row ?? null;
    },

    /** Alla transaktioner som en regel kan gälla, manuella inräknade, för att räkna en regels effekt bakåt. */
    async categorizable(): Promise<CategorizableTransaction[]> {
      return db
        .select({
          id: transactions.id,
          counterpartyNorm: transactions.counterpartyNorm,
          description: transactions.description,
          categoryId: transactions.categoryId,
          categorySource: transactions.categorySource,
        })
        .from(transactions)
        .where(ne(transactions.status, "removed"))
        .all();
    },

    /** Användaren väljer kategori. Den markeras som manuell och rörs sedan aldrig av regler (KK-18-C). */
    async setManualCategory(id: string, categoryId: string): Promise<void> {
      await db.update(transactions).set({ categoryId, categorySource: "manual" }).where(eq(transactions.id, id));
    },

    /** Sparar kategorier i en batch. En manuellt satt kategori skrivs aldrig över (KK-18-C). */
    async setCategories(changes: readonly CategoryChange[]): Promise<void> {
      const statements = changes.map((change) =>
        db
          .update(transactions)
          .set({ categoryId: change.categoryId, categorySource: change.categorySource })
          .where(and(eq(transactions.id, change.id), ne(transactions.categorySource, "manual"))),
      );
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
