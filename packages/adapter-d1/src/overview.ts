/**
 * Det översikten (KK-17) och Inställningar (#34) behöver utöver transaktionerna: kontonas saldon och
 * kopplingarnas status. Inget krypterat läses, så inga nycklar behövs. Transaktionerna hämtas med
 * `budgetRepository`.
 */
import type { D1Database } from "@cloudflare/workers-types";
import type { OverviewAccount } from "@kronkoll/domain";
import { asc, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { accounts, bankConnections } from "./schema.ts";

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
  };
}
