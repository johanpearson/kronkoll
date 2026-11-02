/**
 * Det översikten (KK-17) behöver utöver transaktionerna: kontonas saldon och kopplingarnas status.
 * Inget krypterat läses, så inga nycklar behövs. Transaktionerna hämtas med `budgetRepository`.
 */
import type { D1Database } from "@cloudflare/workers-types";
import type { OverviewAccount } from "@kronkoll/domain";
import { asc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { accounts, bankConnections } from "./schema.ts";

export interface OverviewConnection {
  readonly bank: string | null;
  readonly status: (typeof bankConnections.$inferSelect)["status"];
  readonly consentExpiresOn: string | null;
  /** ISO-tid för senaste lyckade synk, eller null. */
  readonly lastSuccessAt: string | null;
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
        .select({ bank: bankConnections.aspspName, status: bankConnections.status, consentExpiresOn: bankConnections.consentExpiresOn, lastSuccessAt: bankConnections.lastSuccessAt })
        .from(bankConnections)
        .orderBy(asc(bankConnections.id))
        .all();
    },
  };
}
