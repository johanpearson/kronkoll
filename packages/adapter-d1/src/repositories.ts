/**
 * Läsning och skrivning av inställningar, bankkopplingar och konton i D1 (KK-14, KK-11-C).
 *
 * Här sker minimeringen: session-id krypteras innan det skrivs, IBAN blir en HMAC och
 * kontonamnet maskeras. Inget av klartextvärdena lämnar den här modulen mot databasen.
 * Transaktionerna får sitt repository tillsammans med synken (#25), där formen bestäms.
 */
import type { D1Database } from "@cloudflare/workers-types";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { decryptSessionId, encryptSessionId, hashIban, maskAccountName, type Keys } from "./crypto.ts";
import { accounts, bankConnections, settings } from "./schema.ts";

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
    async activate(id: string, input: { sessionId: string; consentExpiresOn: string }): Promise<void> {
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
    /** Raderar kopplingen med dess konton och transaktioner (KK-11). */
    async delete(id: string): Promise<void> {
      await db.delete(bankConnections).where(eq(bankConnections.id, id));
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
  };
}
