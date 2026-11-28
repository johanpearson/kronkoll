/**
 * Kända konton i D1 (KK-54). Matchningen görs i domänen (`linkKnownAccounts`); här sparas kontona med sina
 * matchningstexter och standardkategori, och kopplingarna skrivs. Samma form som lånens (`loan-links.ts`).
 *
 * En kopplad överföring får kontots kategori och vinner över reglerna, men aldrig över en manuell kategori. Kategorin
 * sparas som "learned", och kategoriseringen hoppar över kopplade transaktioner (`uncategorized` och `categorizable`).
 * Tas en automatisk koppling bort släpps kategorin, så att reglerna sätter den igen.
 */
import type { D1Database } from "@cloudflare/workers-types";
import type { KnownAccount, KnownAccountLinkChange, LinkableTransaction } from "@kronkoll/domain";
import { and, asc, eq, gte, isNotNull, ne, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { knownAccounts, transactions } from "./schema.ts";

/** Ett sparat konto. Kategorin är null om den tagits bort eller aldrig valts. */
export type KnownAccountRecord = KnownAccount;

/** Matchningstexterna ur kolumnen. En trasig lista räknas som ingen, så att synken aldrig stoppas av den. */
function parsePatterns(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

const columns = {
  id: knownAccounts.id,
  name: knownAccounts.name,
  patterns: knownAccounts.matchPatterns,
  categoryId: knownAccounts.categoryId,
};

const toRecord = (r: { id: string; name: string; patterns: string; categoryId: string | null }): KnownAccountRecord => ({
  ...r,
  patterns: parsePatterns(r.patterns),
});

const bookedOrBought = sql<string>`coalesce(${transactions.bookingDate}, ${transactions.transactionDate})`;

export function knownAccountRepository(d1: D1Database) {
  const db = drizzle(d1);
  return {
    /** Alla konton i den ordning de lades till. */
    async list(): Promise<KnownAccountRecord[]> {
      const rows = await db.select(columns).from(knownAccounts).orderBy(asc(knownAccounts.createdAt), asc(knownAccounts.id)).all();
      return rows.map(toRecord);
    },

    async get(id: string): Promise<KnownAccountRecord | null> {
      const [row] = await db.select(columns).from(knownAccounts).where(eq(knownAccounts.id, id)).all();
      return row ? toRecord(row) : null;
    },

    /** Lägger till kontot, eller ändrar det om id:t redan finns. Sant om det var nytt (KK-54-A). */
    async save(account: KnownAccountRecord): Promise<boolean> {
      const fields = { name: account.name, matchPatterns: JSON.stringify(account.patterns), categoryId: account.categoryId };
      const existing = await db.select({ id: knownAccounts.id }).from(knownAccounts).where(eq(knownAccounts.id, account.id)).all();
      await db.insert(knownAccounts).values({ id: account.id, ...fields }).onConflictDoUpdate({ target: knownAccounts.id, set: fields }).run();
      return existing.length === 0;
    },

    /** Falskt om kontot inte finns. Kopplade överföringar blir okopplade (ON DELETE SET NULL). */
    async remove(id: string): Promise<boolean> {
      const result = await d1.prepare(`DELETE FROM known_accounts WHERE id = ?`).bind(id).run();
      return result.meta.changes > 0;
    },

    /**
     * Transaktioner som kan höra till ett konto, från och med ett datum (null för all historik), plus alla som redan
     * är kopplade, så att en koppling som inte längre stämmer kan tas bort.
     */
    async candidates(since: string | null): Promise<LinkableTransaction[]> {
      const wanted = since === null ? undefined : or(gte(bookedOrBought, since), isNotNull(transactions.knownAccountId));
      const rows = await db
        .select({
          id: transactions.id,
          counterpartyNorm: transactions.counterpartyNorm,
          description: transactions.description,
          knownAccountId: transactions.knownAccountId,
          knownAccountSource: transactions.knownAccountSource,
        })
        .from(transactions)
        .where(and(ne(transactions.status, "removed"), wanted))
        .all();
      return rows;
    },

    /**
     * Kopplar en överföring till ett konto för hand, eller tar bort kopplingen med null (KK-54-C). Kopplingen blir
     * manuell, så att matchningen aldrig ändrar den. Kontots kategori sätts eller släpps som när matchningen gör det,
     * men en manuell kategori rörs aldrig. Falskt om transaktionen eller kontot inte finns.
     */
    async setManual(transactionId: string, knownAccountId: string | null): Promise<boolean> {
      const [tx] = await db
        .select({ knownAccountId: transactions.knownAccountId })
        .from(transactions)
        .where(and(eq(transactions.id, transactionId), ne(transactions.status, "removed")))
        .all();
      const [account] = knownAccountId === null ? [] : await db.select({ categoryId: knownAccounts.categoryId }).from(knownAccounts).where(eq(knownAccounts.id, knownAccountId)).all();
      if (!tx || (knownAccountId !== null && !account)) return false;
      const row = eq(transactions.id, transactionId);
      const notManualCategory = and(row, ne(transactions.categorySource, "manual"));
      const categoryId = account?.categoryId ?? null;
      const category =
        knownAccountId === null
          ? tx.knownAccountId === null
            ? []
            : [db.update(transactions).set({ categoryId: null, categorySource: "none" }).where(notManualCategory)]
          : categoryId === null
            ? []
            : [db.update(transactions).set({ categoryId, categorySource: "learned" }).where(notManualCategory)];
      await db.batch([db.update(transactions).set({ knownAccountId, knownAccountSource: "manual" }).where(row), ...category]);
      return true;
    },

    /**
     * Skriver kopplingarna från `linkKnownAccounts`. En ny koppling ger kontots kategori om kontot har en och kategorin
     * inte är manuell. En borttagen automatisk koppling släpper kategorin. Manuella kopplingar rörs aldrig.
     */
    async apply(changes: readonly KnownAccountLinkChange[], accountList: readonly KnownAccountRecord[]): Promise<void> {
      const categoryOf = new Map(accountList.map((a) => [a.id, a.categoryId]));
      const notManualLink = or(sql`${transactions.knownAccountSource} IS NULL`, eq(transactions.knownAccountSource, "auto"));
      const statements = changes.flatMap((change) => {
        const row = and(eq(transactions.id, change.id), notManualLink);
        const notManualCategory = and(row, ne(transactions.categorySource, "manual"));
        if (change.knownAccountId === null) {
          return [
            db.update(transactions).set({ categoryId: null, categorySource: "none" }).where(and(notManualCategory, isNotNull(transactions.knownAccountId))),
            db.update(transactions).set({ knownAccountId: null, knownAccountSource: null }).where(row),
          ];
        }
        const categoryId = categoryOf.get(change.knownAccountId) ?? null;
        return [
          ...(categoryId === null ? [] : [db.update(transactions).set({ categoryId, categorySource: "learned" }).where(notManualCategory)]),
          db.update(transactions).set({ knownAccountId: change.knownAccountId, knownAccountSource: "auto" }).where(row),
        ];
      });
      const [first, ...rest] = statements;
      if (first) await db.batch([first, ...rest]);
    },
  };
}
