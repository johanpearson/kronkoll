/**
 * D1-schemat för M1 (D-orm). Migreringarna i ../migrations genereras från den här filen med
 * `pnpm --filter @kronkoll/adapter-d1 db:generate` och ändras aldrig för hand i efterhand.
 *
 * - Belopp är heltal öre med tecken (D-money). Datum är svenska kalenderdagar som text
 *   (YYYY-MM-DD), tidpunkter är ISO 8601 i UTC.
 * - Inga råa svar från banken sparas (KK-11-C): det finns ingen JSON- eller rå-kolumn. IBAN
 *   sparas bara som HMAC och kontonamnet maskerat, och sessionens id är krypterat (AES-GCM).
 * - En användare och inget hushåll (KK-28): inga hushålls-, ägar- eller synlighetsfält.
 *   Appens inställningar ligger i en enda rad i `settings`.
 * - Raderas en bankkoppling försvinner dess konton och transaktioner med den (KK-11).
 */
import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

const oneOf = (column: string, values: readonly string[]) =>
  sql.raw(`${column} IN (${values.map((v) => `'${v}'`).join(", ")})`);
const isoDate = (column: string) => sql.raw(`${column} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`);
/** BLOB som Uint8Array, utan Node:s Buffer, så att det fungerar i Workern. D1 returnerar BLOB som tal-array. */
const bytes = customType<{ data: Uint8Array; driverData: Uint8Array | ArrayBuffer | number[] }>({
  dataType: () => "blob",
  toDriver: (value) => value,
  fromDriver: (value) => (value instanceof Uint8Array ? value : Array.isArray(value) ? Uint8Array.from(value) : new Uint8Array(value)),
});
const createdAt = () => text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`);

export const settings = sqliteTable(
  "settings",
  {
    id: text("id").primaryKey().default("settings"),
    budgetPeriodStartDay: integer("budget_period_start_day").notNull().default(1),
    timezone: text("timezone").notNull().default("Europe/Stockholm"),
  },
  () => [
    check("settings_single_row", sql`id = 'settings'`),
    check("settings_start_day", sql`budget_period_start_day BETWEEN 1 AND 28`),
  ],
);

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    theme: text("theme", { enum: ["system", "light", "dark"] }).notNull().default("system"),
    createdAt: createdAt(),
  },
  (t) => [check("users_theme", oneOf("theme", ["system", "light", "dark"])), uniqueIndex("users_email").on(t.email)],
);

const CONNECTION_STATUS = ["pending_auth", "active", "expiring", "expired", "revoked"] as const;

export const bankConnections = sqliteTable(
  "bank_connections",
  {
    id: text("id").primaryKey(),
    provider: text("provider", { enum: ["enablebanking", "csv"] }).notNull(),
    aspspName: text("aspsp_name"),
    /** Enable Bankings session-id, krypterat med SESSION_ENC_KEY (AES-GCM). Aldrig i klartext. */
    sessionIdEnc: bytes("session_id_enc"),
    status: text("status", { enum: CONNECTION_STATUS }).notNull().default("pending_auth"),
    consentExpiresOn: text("consent_expires_on"),
    lastSuccessAt: text("last_success_at"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    createdAt: createdAt(),
  },
  () => [
    check("bank_connections_provider", oneOf("provider", ["enablebanking", "csv"])),
    check("bank_connections_status", oneOf("status", CONNECTION_STATUS)),
    check("bank_connections_consent_date", sql`consent_expires_on IS NULL OR ${isoDate("consent_expires_on")}`),
  ],
);

/**
 * Engångs-state för bankflödet (KK-29-A, T-S2). Bara id:t sparas, aldrig den signerade
 * strängen. Raden är bunden till användaren och kopplingen och kan användas en gång.
 */
export const connectStates = sqliteTable(
  "connect_states",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => bankConnections.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    expiresAt: text("expires_at").notNull(),
    usedAt: text("used_at"),
    createdAt: createdAt(),
  },
  (t) => [index("connect_states_expires").on(t.expiresAt)],
);

const ACCOUNT_TYPES =["checking", "credit_card", "savings", "loan", "manual"] as const;

export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => bankConnections.id, { onDelete: "cascade" }),
    providerUid: text("provider_uid"),
    /** HMAC av IBAN, för att känna igen kontot vid koppla om utan att spara IBAN. */
    ibanHash: text("iban_hash"),
    /** Maskerat, t.ex. "Privatkonto ••4821". */
    displayName: text("display_name").notNull(),
    type: text("type", { enum: ACCOUNT_TYPES }).notNull(),
    balanceMinor: integer("balance_minor"),
    /** Kontot räknas in i översiktens totala saldo (KK-17-A). */
    included: integer("included", { mode: "boolean" }).notNull().default(true),
    syncCursor: text("sync_cursor"),
  },
  (t) => [
    check("accounts_type", oneOf("type", ACCOUNT_TYPES)),
    uniqueIndex("accounts_provider_uid").on(t.connectionId, t.providerUid),
  ],
);

const CATEGORY_SOURCE = ["manual", "learned", "template", "none"] as const;
const INCOME_TYPES = ["salary", "parental_benefit", "other"] as const;

export const categories = sqliteTable(
  "categories",
  {
    id: text("id").primaryKey(),
    parentId: text("parent_id").references((): AnySQLiteColumn => categories.id),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["expense", "income", "transfer"] }).notNull(),
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    color: text("color"),
  },
  (t) => [
    check("categories_kind", oneOf("kind", ["expense", "income", "transfer"])),
    index("categories_parent").on(t.parentId),
  ],
);

export const transactions = sqliteTable(
  "transactions",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    providerTxId: text("provider_tx_id"),
    fingerprint: text("fingerprint").notNull(),
    status: text("status", { enum: ["pending", "booked", "removed"] }).notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    transactionDate: text("transaction_date").notNull(),
    bookingDate: text("booking_date"),
    amountMinor: integer("amount_minor").notNull(),
    counterparty: text("counterparty").notNull().default(""),
    counterpartyNorm: text("counterparty_norm").notNull().default(""),
    /** Bankens meddelande, högst 140 tecken. */
    description: text("description").notNull().default(""),
    categoryId: text("category_id").references(() => categories.id),
    categorySource: text("category_source", { enum: CATEGORY_SOURCE }).notNull().default("none"),
    incomeType: text("income_type", { enum: INCOME_TYPES }),
    isInternalTransfer: integer("is_internal_transfer", { mode: "boolean" }).notNull().default(false),
    transferPairId: text("transfer_pair_id").references((): AnySQLiteColumn => transactions.id, { onDelete: "set null" }),
  },
  (t) => [
    check("transactions_status", oneOf("status", ["pending", "booked", "removed"])),
    check("transactions_category_source", oneOf("category_source", CATEGORY_SOURCE)),
    check("transactions_income_type", sql`income_type IS NULL OR ${oneOf("income_type", INCOME_TYPES)}`),
    check("transactions_dates", sql`${isoDate("transaction_date")} AND (booking_date IS NULL OR ${isoDate("booking_date")})`),
    check("transactions_description_length", sql`length(description) <= 140`),
    index("transactions_account_date").on(t.accountId, t.transactionDate),
    index("transactions_fingerprint").on(t.accountId, t.fingerprint),
    uniqueIndex("transactions_provider_id").on(t.accountId, t.providerTxId),
    index("transactions_category").on(t.categoryId),
  ],
);

export const transactionSplits = sqliteTable(
  "transaction_splits",
  {
    id: text("id").primaryKey(),
    transactionId: text("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    categoryId: text("category_id")
      .notNull()
      .references(() => categories.id),
    amountMinor: integer("amount_minor").notNull(),
  },
  (t) => [index("transaction_splits_transaction").on(t.transactionId)],
);

const RULE_MATCH = ["counterparty_prefix", "counterparty_exact", "description_contains", "amount_range"] as const;

export const categoryRules = sqliteTable(
  "category_rules",
  {
    id: text("id").primaryKey(),
    match: text("match", { enum: RULE_MATCH }).notNull(),
    pattern: text("pattern").notNull(),
    categoryId: text("category_id").references(() => categories.id),
    incomeType: text("income_type", { enum: INCOME_TYPES }),
    source: text("source", { enum: ["template", "learned"] }).notNull(),
    priority: integer("priority").notNull().default(0),
    hits: integer("hits").notNull().default(0),
  },
  () => [
    check("category_rules_match", oneOf("match", RULE_MATCH)),
    check("category_rules_source", oneOf("source", ["template", "learned"])),
    check("category_rules_target", sql`category_id IS NOT NULL OR income_type IS NOT NULL`),
  ],
);

export const budgetLines = sqliteTable(
  "budget_lines",
  {
    /** Budgetperiodens nyckel, t.ex. "2026-11" (KK-34). */
    period: text("period").notNull(),
    categoryId: text("category_id")
      .notNull()
      .references(() => categories.id),
    amountMinor: integer("amount_minor").notNull(),
    source: text("source", { enum: ["manual", "copy_previous", "average_3m"] }).notNull().default("manual"),
  },
  (t) => [
    primaryKey({ columns: [t.period, t.categoryId] }),
    check("budget_lines_period", sql`period GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'`),
    check("budget_lines_amount", sql`amount_minor >= 0`),
    check("budget_lines_source", oneOf("source", ["manual", "copy_previous", "average_3m"])),
  ],
);

/** Driftlogg utan bankdata. Gallras efter 90 dagar (D-retention). */
export const syncRuns = sqliteTable(
  "sync_runs",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id").references(() => bankConnections.id, { onDelete: "set null" }),
    kind: text("kind", { enum: ["cron", "manual", "initial", "daily"] }).notNull(),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    status: text("status", { enum: ["running", "ok", "partial", "failed"] }).notNull().default("running"),
    newCount: integer("new_count").notNull().default(0),
    updatedCount: integer("updated_count").notNull().default(0),
    /** Felkod som EB_429 eller CONSENT_EXPIRED, aldrig svarstext från banken. */
    errorCode: text("error_code"),
  },
  (t) => [
    check("sync_runs_kind", oneOf("kind", ["cron", "manual", "initial", "daily"])),
    check("sync_runs_status", oneOf("status", ["running", "ok", "partial", "failed"])),
    check("sync_runs_error_code", sql`error_code IS NULL OR (error_code <> '' AND error_code NOT GLOB '*[^A-Z0-9_]*')`),
    index("sync_runs_started").on(t.startedAt),
  ],
);
