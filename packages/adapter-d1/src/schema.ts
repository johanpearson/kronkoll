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
const ACCOUNT_ROLES = ["spending", "buffer", "excluded"] as const;

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
    /** Användarens eget namn, t.ex. "Privat kort" (KK-37). Synken skriver aldrig över det. */
    nickname: text("nickname"),
    type: text("type", { enum: ACCOUNT_TYPES }).notNull(),
    balanceMinor: integer("balance_minor"),
    /** Kontots roll (KK-53): Inkomst/Utgift, Buffert eller Uteslutet. Ersatte included och saving (KK-53-B). */
    role: text("role", { enum: ACCOUNT_ROLES }).notNull().default("spending"),
    syncCursor: text("sync_cursor"),
  },
  (t) => [
    check("accounts_type", oneOf("type", ACCOUNT_TYPES)),
    check("accounts_role", oneOf("role", ACCOUNT_ROLES)),
    uniqueIndex("accounts_provider_uid").on(t.connectionId, t.providerUid),
  ],
);

const CATEGORY_SOURCE = ["manual", "learned", "template", "none"] as const;
const INCOME_TYPES = ["salary", "parental_benefit", "other"] as const;
const INCOME_SOURCE = CATEGORY_SOURCE;
const SAVING_KINDS = ["saving", "saving_withdrawal", "saving_deposit"] as const;

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
    /**
     * Var inkomsttypen kom ifrån (KK-22-A). "manual" skrivs aldrig över av regler. Ingen CHECK: SQLite kan
     * bara lägga till en CHECK genom att bygga om tabellen, och då raderas uppdelningar och parningar.
     */
    incomeSource: text("income_source", { enum: INCOME_SOURCE }).notNull().default("none"),
    isInternalTransfer: integer("is_internal_transfer", { mode: "boolean" }).notNull().default(false),
    transferPairId: text("transfer_pair_id").references((): AnySQLiteColumn => transactions.id, { onDelete: "set null" }),
    /** Användarens eget val (KK-20-C): 1 = räkna inte som utgift, 0 = räkna som utgift, null = automatiskt. */
    manualTransfer: integer("manual_transfer", { mode: "boolean" }),
    /** Dold av användaren (KK-49): syns inte i listan och räknas inte någonstans. Påverkar inte `manualTransfer`. */
    hidden: integer("hidden", { mode: "boolean" }).notNull().default(false),
    /**
     * Hur transaktionen rör en buffert (KK-53, KK-55): sparande, uttag från sparande eller insättning från ett
     * uteslutet konto. Null annars. Skrivs när överföringarna räknas om. Ingen CHECK, av samma skäl som income_source.
     */
    savingKind: text("saving_kind", { enum: SAVING_KINDS }),
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
/** Vad en regel gör med sina träffar: sätter kategori, eller Räkna inte (KK-39-C). */
const RULE_ACTION = ["categorize", "exclude"] as const;

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
    action: text("action", { enum: RULE_ACTION }).notNull().default("categorize"),
  },
  () => [
    check("category_rules_match", oneOf("match", RULE_MATCH)),
    check("category_rules_source", oneOf("source", ["template", "learned"])),
    check("category_rules_action", oneOf("action", RULE_ACTION)),
    // En regel sätter kategori eller inkomsttyp, eller är en Räkna inte-regel utan kategori.
    check("category_rules_target", sql`(action = 'categorize' AND (category_id IS NOT NULL OR income_type IS NOT NULL)) OR (action = 'exclude' AND category_id IS NULL)`),
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

/** Perioder som markerats som engångsperioder i budgetplaneraren (KK-42-E). */
export const guidelineOneOffPeriods = sqliteTable(
  "guideline_one_off_periods",
  { period: text("period").primaryKey() },
  () => [check("guideline_one_off_period", sql`period GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'`)],
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

/**
 * Lån (KK-36, beslut D-loans). Läggs in för hand; inget lån hämtas från banken. Ett bolån i flera
 * delar är ett lån per del. Räntan i hundradels procent (350 = 3,50 %).
 */
export const loans = sqliteTable(
  "loans",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    lender: text("lender"),
    balanceMinor: integer("balance_minor").notNull(),
    interestRateBp: integer("interest_rate_bp").notNull(),
    /** Sista dagen med bunden ränta, null för rörlig ränta. */
    rateFixedUntil: text("rate_fixed_until"),
    amortizationMinor: integer("amortization_minor").notNull(),
    createdAt: createdAt(),
  },
  () => [
    check("loans_name", sql`length(trim(name)) BETWEEN 1 AND 60`),
    check("loans_lender", sql`lender IS NULL OR length(lender) <= 60`),
    check("loans_balance", sql`balance_minor >= 0`),
    check("loans_rate", sql`interest_rate_bp BETWEEN 0 AND 10000`),
    check("loans_amortization", sql`amortization_minor >= 0`),
    check("loans_rate_fixed_until", sql`rate_fixed_until IS NULL OR ${isoDate("rate_fixed_until")}`),
  ],
);

/**
 * Web Push-prenumerationer (KK-27, D-notify), en per enhet. Adressen är push-tjänstens och
 * nycklarna är webbläsarens publika nyckel och hemlighet för krypteringen. `topics` är de valda
 * notistyperna som JSON-lista. Samma adress igen ersätter raden.
 */
export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    id: text("id").primaryKey(),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    topics: text("topics").notNull().default("[]"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("push_subscriptions_endpoint").on(t.endpoint),
    check("push_subscriptions_endpoint_https", sql`endpoint LIKE 'https://%' AND length(endpoint) <= 1024`),
    check("push_subscriptions_keys", sql`length(p256dh) BETWEEN 1 AND 100 AND length(auth) BETWEEN 1 AND 30`),
    check("push_subscriptions_topics", sql`json_valid(topics) AND json_type(topics) = 'array'`),
  ],
);

const NOTICE_KINDS = ["budget", "consent"] as const;

/**
 * Notiser som redan skickats, så att samma notis aldrig skickas två gånger (KK-27-A, KK-27-B).
 * Budget: `scope` är perioden och `item` kategorin. Samtycke: `scope` är kopplingen och
 * utgångsdagen, och `item` gränsen (14, 3 eller 0). Inga belopp eller texter sparas.
 */
export const sentNotices = sqliteTable(
  "sent_notices",
  {
    kind: text("kind", { enum: NOTICE_KINDS }).notNull(),
    scope: text("scope").notNull(),
    item: text("item").notNull(),
    sentAt: text("sent_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  },
  (t) => [primaryKey({ columns: [t.kind, t.scope, t.item] }), check("sent_notices_kind", oneOf("kind", NOTICE_KINDS))],
);