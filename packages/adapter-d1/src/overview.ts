/**
 * Det översikten (KK-17) och Inställningar (#34) behöver utöver transaktionerna: kontonas saldon och
 * kopplingarnas status. Inget krypterat läses, så inga nycklar behövs. Transaktionerna hämtas med
 * `budgetRepository`.
 */
import type { D1Database } from "@cloudflare/workers-types";
import type { OverviewAccount } from "@kronkoll/domain";
import { asc, desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { accounts, bankConnections, syncRuns } from "./schema.ts";

export interface OverviewConnection {
  readonly id: string;
  readonly bank: string | null;
  readonly status: (typeof bankConnections.$inferSelect)["status"];
  readonly consentExpiresOn: string | null;
  /** ISO-tid för senaste lyckade synk, eller null. */
  readonly lastSuccessAt: string | null;
  /** Misslyckade synkar i rad sedan den senaste lyckade. */
  readonly consecutiveFailures: number;
  readonly accountCount: number;
}

export function overviewRepository(d1: D1Database) {
  const db = drizzle(d1);
  return {
    /** Saldo och om kontot räknas in. Ett konto utan saldo från banken räknas som noll. */
    async accounts(): Promise<OverviewAccount[]> {
      const rows = await db.select({ balanceMinor: accounts.balanceMinor, included: accounts.included }).from(accounts).all();
      return rows.map((r) => ({ balanceMinor: r.balanceMinor ?? 0, included: r.included }));
    },

    async connections(): Promise<OverviewConnection[]> {
      return db
        .select({
          id: bankConnections.id,
          bank: bankConnections.aspspName,
          status: bankConnections.status,
          consentExpiresOn: bankConnections.consentExpiresOn,
          lastSuccessAt: bankConnections.lastSuccessAt,
          consecutiveFailures: bankConnections.consecutiveFailures,
          // Kolumnerna skrivs med tabellnamn, eftersom Drizzle annars lämnar "id" okvalificerat i underfrågan.
          accountCount: sql<number>`(SELECT count(*) FROM accounts WHERE accounts.connection_id = bank_connections.id)`,
        })
        .from(bankConnections)
        .orderBy(asc(bankConnections.id))
        .all();
    },

    /** En kopplings konton med namn som de visas, typ och saldo, för sidan om kopplingen. */
    async connectionAccounts(connectionId: string): Promise<ConnectionAccount[]> {
      return db
        .select({
          id: accounts.id,
          name: sql<string>`coalesce(${accounts.nickname}, ${accounts.displayName})`,
          type: accounts.type,
          balanceMinor: accounts.balanceMinor,
        })
        .from(accounts)
        .where(eq(accounts.connectionId, connectionId))
        .orderBy(asc(accounts.displayName), asc(accounts.id))
        .all();
    },

    /** De senaste synkkörningarna för en koppling, nyast först (KK-7-A). Bara status och antal, ingen bankdata. */
    async syncRuns(connectionId: string, limit: number): Promise<SyncRunRow[]> {
      return db
        .select({
          kind: syncRuns.kind,
          status: syncRuns.status,
          startedAt: syncRuns.startedAt,
          finishedAt: syncRuns.finishedAt,
          newCount: syncRuns.newCount,
          updatedCount: syncRuns.updatedCount,
          errorCode: syncRuns.errorCode,
        })
        .from(syncRuns)
        .where(eq(syncRuns.connectionId, connectionId))
        .orderBy(desc(syncRuns.startedAt))
        .limit(limit)
        .all();
    },
  };
}

export interface ConnectionAccount {
  readonly id: string;
  /** Eget namn om det finns, annars bankens maskerade (KK-37). */
  readonly name: string;
  readonly type: (typeof accounts.$inferSelect)["type"];
  readonly balanceMinor: number | null;
}

export type SyncRunRow = Pick<
  typeof syncRuns.$inferSelect,
  "kind" | "status" | "startedAt" | "finishedAt" | "newCount" | "updatedCount" | "errorCode"
>;
