/**
 * Läsning och skrivning av inställningar, bankkopplingar och konton i D1 (KK-14, KK-11-C).
 *
 * Här sker minimeringen: session-id krypteras innan det skrivs, IBAN blir en HMAC och
 * kontonamnet maskeras. Inget av klartextvärdena lämnar den här modulen mot databasen.
 * Körningsloggen (sync_runs) hör också hit. Transaktionerna får sitt repository i ett senare steg av synken (#25).
 */
import type { D1Database } from "@cloudflare/workers-types";
import { assertMinor, nextConsecutiveFailures, type SyncRunSummary } from "@kronkoll/domain";
import { and, asc, eq, max } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { decryptSessionId, encryptSessionId, hashIban, maskAccountName, type Keys } from "./crypto.ts";
import { accounts, bankConnections, settings, syncRuns } from "./schema.ts";

export interface Settings {
  readonly budgetPeriodStartDay: number;
  readonly timezone: string;
}

export function settingsRepository(d1: D1Database) {
  const db = drizzle(d1);
  return {
    async get(): Promise<Settings> {
      const row = await db.select().from(settings).get();
      if (!row) throw new Error("Inställningsraden saknas. Har migreringarna körts?");
      return { budgetPeriodStartDay: row.budgetPeriodStartDay, timezone: row.timezone };
    },
    async setBudgetPeriodStartDay(day: number): Promise<void> {
      if (!Number.isInteger(day) || day < 1 || day > 28) throw new RangeError("Startdagen måste vara 1–28");
      await db.update(settings).set({ budgetPeriodStartDay: day });
    },
  };
}

export type ConnectionStatus = (typeof bankConnections.$inferSelect)["status"];

export interface Connection {
  readonly id: string;
  readonly provider: "enablebanking" | "csv";
  readonly aspspName: string | null;
  readonly status: ConnectionStatus;
  readonly consentExpiresOn: string | null;
}

export interface HistoryCounts {
  readonly accounts: number;
  readonly transactions: number;
  readonly splits: number;
}

/**
 * Hur mycket historik som raderas med en koppling, för frågan och kvittensen (KK-11-B). Behöver inga
 * nycklar, så sidan om kopplingen kan visa det.
 */
export async function connectionHistoryCounts(d1: D1Database, id: string): Promise<HistoryCounts> {
  const row = await d1
    .prepare(
      `SELECT
         (SELECT count(*) FROM accounts WHERE connection_id = ?1) AS accounts,
         (SELECT count(*) FROM transactions WHERE account_id IN (SELECT id FROM accounts WHERE connection_id = ?1)) AS transactions,
         (SELECT count(*) FROM transaction_splits WHERE transaction_id IN
           (SELECT t.id FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE a.connection_id = ?1)) AS splits`,
    )
    .bind(id)
    .first<HistoryCounts>();
  return { accounts: row?.accounts ?? 0, transactions: row?.transactions ?? 0, splits: row?.splits ?? 0 };
}

export function connectionRepository(d1: D1Database, keys: Keys) {
  const db = drizzle(d1);
  const toConnection = (row: typeof bankConnections.$inferSelect): Connection => ({
    id: row.id,
    provider: row.provider,
    aspspName: row.aspspName,
    status: row.status,
    consentExpiresOn: row.consentExpiresOn,
  });
  return {
    async create(input: { id: string; provider: Connection["provider"]; aspspName: string | null }): Promise<void> {
      await db.insert(bankConnections).values(input);
    },
    async get(id: string): Promise<Connection | null> {
      const row = await db.select().from(bankConnections).where(eq(bankConnections.id, id)).get();
      return row ? toConnection(row) : null;
    },
    async list(): Promise<Connection[]> {
      return (await db.select().from(bankConnections).all()).map(toConnection);
    },
    /** Banken har godkänt samtycket: spara det krypterade session-id:t och utgångsdagen. */
    async activate(id: string, input: { sessionId: string; consentExpiresOn: string | null }): Promise<void> {
      const sessionIdEnc = await encryptSessionId(keys, input.sessionId);
      await db
        .update(bankConnections)
        .set({ sessionIdEnc, consentExpiresOn: input.consentExpiresOn, status: "active", consecutiveFailures: 0 })
        .where(eq(bankConnections.id, id));
    },
    async sessionId(id: string): Promise<string | null> {
      const row = await db.select({ enc: bankConnections.sessionIdEnc }).from(bankConnections).where(eq(bankConnections.id, id)).get();
      return row?.enc ? decryptSessionId(keys, row.enc) : null;
    },
    async setStatus(id: string, status: ConnectionStatus): Promise<void> {
      await db.update(bankConnections).set({ status }).where(eq(bankConnections.id, id));
    },
    /** Samtycket har gått ut eller banken nekar åtkomst: kopplingen behöver kopplas om (KK-8). */
    async expire(id: string): Promise<void> {
      const row = await db.select({ id: bankConnections.id }).from(bankConnections).where(eq(bankConnections.id, id)).get();
      if (!row) throw new Error("Kopplingen finns inte");
      await db.update(bankConnections).set({ status: "expired" }).where(eq(bankConnections.id, id));
    },
    /**
     * Registrerar utfallet av en synk. Tidpunkten för senaste lyckade synk sätts bara när alla
     * konton gick bra, och felräknaren nollställs om inte hela körningen misslyckades. Returnerar
     * antal misslyckade körningar i rad, som avgör om notisen ska skickas (KK-7-B).
     */
    async recordSyncOutcome(id: string, status: SyncRunSummary["status"], at: string): Promise<number> {
      const row = await db
        .select({ failures: bankConnections.consecutiveFailures })
        .from(bankConnections)
        .where(eq(bankConnections.id, id))
        .get();
      if (!row) throw new Error("Kopplingen finns inte");
      const consecutiveFailures = nextConsecutiveFailures(row.failures, status);
      await db
        .update(bankConnections)
        .set(status === "ok" ? { consecutiveFailures, lastSuccessAt: at } : { consecutiveFailures })
        .where(eq(bankConnections.id, id));
      return consecutiveFailures;
    },
    /** Raderar kopplingen med dess konton och transaktioner (KK-11). */
    /**
     * Raderar kopplingen. Konton, transaktioner, uppdelningar och saldon följer med via ON DELETE CASCADE,
     * och motposter i andra konton tappar sin koppling (SET NULL) (KK-11-B).
     */
    async delete(id: string): Promise<void> {
      await db.delete(bankConnections).where(eq(bankConnections.id, id));
    },
    /** Sessionen är återkallad hos banken: session-id raderas, men konton och historik finns kvar (KK-11-A). */
    async revoke(id: string): Promise<void> {
      await db.update(bankConnections).set({ status: "revoked", sessionIdEnc: null }).where(eq(bankConnections.id, id));
    },
    historyCounts: (id: string) => connectionHistoryCounts(d1, id),
  };
}

export type SyncRun = typeof syncRuns.$inferSelect;

/** Körningsloggen. Innehåller bara antal, tider och felkoder, aldrig bankdata (KK-13). */
export function syncRunRepository(d1: D1Database) {
  const db = drizzle(d1);
  return {
    async start(input: { id: string; connectionId: string; kind: SyncRun["kind"]; startedAt: string }): Promise<void> {
      await db.insert(syncRuns).values({ ...input, status: "running" });
    },
    async finish(id: string, finishedAt: string, summary: SyncRunSummary): Promise<void> {
      await db
        .update(syncRuns)
        .set({ finishedAt, status: summary.status, newCount: summary.newCount, updatedCount: summary.updatedCount, errorCode: summary.errorCode })
        .where(eq(syncRuns.id, id));
    },
    async get(id: string): Promise<SyncRun | null> {
      return (await db.select().from(syncRuns).where(eq(syncRuns.id, id)).get()) ?? null;
    },
    /**
     * Hur det går för körningarna som startat från och med en tidpunkt: hur många som startat och hur
     * många som fortfarande pågår. Appen frågar efter Synka nu tills alla är klara (KK-7-C).
     */
    async progressSince(since: string): Promise<{ started: number; running: number }> {
      const row = await d1
        .prepare(`SELECT count(*) AS started, coalesce(sum(status = 'running'), 0) AS running FROM sync_runs WHERE started_at >= ?`)
        .bind(since)
        .first<{ started: number; running: number }>();
      return { started: row?.started ?? 0, running: row?.running ?? 0 };
    },
    /** När startades den senaste manuella synken? Underlag för gränsen en gång per 15 minuter (KK-7-C). */
    async lastManualStartedAt(): Promise<Date | null> {
      const row = await db.select({ at: max(syncRuns.startedAt) }).from(syncRuns).where(eq(syncRuns.kind, "manual")).get();
      return row?.at ? new Date(row.at) : null;
    },
  };
}

export interface BankAccountInput {
  readonly connectionId: string;
  readonly providerUid: string;
  readonly iban: string | null;
  /** Bankens namn på kontot, i klartext. Maskeras innan det sparas. */
  readonly name: string;
  readonly type: (typeof accounts.$inferSelect)["type"];
  readonly balanceMinor: number | null;
}

export interface NamedAccount {
  readonly id: string;
  /** Användarens eget namn, eller null om kontot heter som hos banken. */
  readonly nickname: string | null;
  /** Bankens maskerade namn, t.ex. "Privatkonto ••4821". */
  readonly bankName: string;
  readonly bank: string | null;
  readonly type: (typeof accounts.$inferSelect)["type"];
}

/** Egna kontonamn (KK-37). Behöver inga nycklar, eftersom inget krypterat läses eller skrivs. */
export function accountNameRepository(d1: D1Database) {
  const db = drizzle(d1);
  return {
    /** Kontona med eget namn, bankens maskerade namn och bankens namn, för Inställningar. */
    async list(): Promise<NamedAccount[]> {
      return db
        .select({ id: accounts.id, nickname: accounts.nickname, bankName: accounts.displayName, bank: bankConnections.aspspName, type: accounts.type })
        .from(accounts)
        .innerJoin(bankConnections, eq(bankConnections.id, accounts.connectionId))
        .orderBy(asc(accounts.displayName), asc(accounts.id))
        .all();
    },
    /** Sätter kontots egna namn, eller tar bort det med null. Falskt om kontot inte finns. */
    async set(accountId: string, nickname: string | null): Promise<boolean> {
      const updated = await db.update(accounts).set({ nickname }).where(eq(accounts.id, accountId)).returning({ id: accounts.id }).all();
      return updated.length > 0;
    },
  };
}

export function accountRepository(d1: D1Database, keys: Keys) {
  const db = drizzle(d1);
  return {
    /**
     * Sparar ett konto från banken. Finns kontot redan i kopplingen uppdateras det. Annars känns
     * det igen på IBAN-hashen från en tidigare koppling (koppla om, KK-8-B) och flyttas, så att
     * historik och kategorier följer med. Returnerar kontots id.
     */
    async upsertFromBank(input: BankAccountInput, newId: () => string): Promise<string> {
      const ibanHash = input.iban === null ? null : await hashIban(keys, input.iban);
      const values = {
        connectionId: input.connectionId,
        providerUid: input.providerUid,
        ibanHash,
        displayName: maskAccountName(input.name, input.iban),
        type: input.type,
        balanceMinor: input.balanceMinor,
      };
      const existing =
        (await db
          .select({ id: accounts.id })
          .from(accounts)
          .where(and(eq(accounts.connectionId, input.connectionId), eq(accounts.providerUid, input.providerUid)))
          .get()) ?? (ibanHash === null ? undefined : await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.ibanHash, ibanHash)).get());
      if (existing) {
        await db.update(accounts).set(values).where(eq(accounts.id, existing.id));
        return existing.id;
      }
      const id = newId();
      await db.insert(accounts).values({ id, ...values });
      return id;
    },
    async list(): Promise<(typeof accounts.$inferSelect)[]> {
      return db.select().from(accounts).all();
    },
    /** Kopplingens konton hos banken. Manuella konton saknar bankens id och synkas inte. */
    async listForConnection(connectionId: string): Promise<{ id: string; providerUid: string }[]> {
      const rows = await db
        .select({ id: accounts.id, providerUid: accounts.providerUid })
        .from(accounts)
        .where(eq(accounts.connectionId, connectionId))
        .all();
      return rows.flatMap((r) => (r.providerUid === null ? [] : [{ id: r.id, providerUid: r.providerUid }]));
    },
    /** Bokfört saldo från banken i öre (heltal med tecken). */
    async setBalance(accountId: string, balanceMinor: number): Promise<void> {
      assertMinor(balanceMinor);
      const exists = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, accountId)).get();
      if (!exists) throw new Error("Kontot finns inte");
      await db.update(accounts).set({ balanceMinor }).where(eq(accounts.id, accountId));
    },
  };
}
