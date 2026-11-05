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
  real,
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
    /** Användarens eget namn, t.ex. "Privat kort" (KK-37). Synken skriver aldrig över det. */
    nickname: text("nickname"),
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
const INCOME_SOURCE = CATEGORY_SOURCE;

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

const GOAL_SOURCE = ["manual", "account"] as const;

/**
 * Sparmål (KK-21). Ett mål bygger på manuella avsättningar eller på saldot i ett kopplat konto.
 * Försvinner kontot (kopplingen raderas) blir målet kvar utan konto, så att det inte tas bort i tysthet.
 */
export const savingsGoals = sqliteTable(
  "savings_goals",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    targetMinor: integer("target_minor").notNull(),
    targetDate: text("target_date"),
    source: text("source", { enum: GOAL_SOURCE }).notNull(),
    accountId: text("account_id").references(() => accounts.id, { onDelete: "set null" }),
    /** Redan sparat när målet skapades, för manuella mål. */
    initialMinor: integer("initial_minor").notNull().default(0),
    createdAt: createdAt(),
  },
  () => [
    check("savings_goals_source", oneOf("source", GOAL_SOURCE)),
    check("savings_goals_manual_has_no_account", sql`source = 'account' OR account_id IS NULL`),
    check("savings_goals_target", sql`target_minor > 0`),
    check("savings_goals_initial", sql`initial_minor >= 0`),
    check("savings_goals_name", sql`length(trim(name)) BETWEEN 1 AND 60`),
    check("savings_goals_target_date", sql`target_date IS NULL OR ${isoDate("target_date")}`),
  ],
);

/** Manuella avsättningar till ett sparmål. Ett negativt belopp är ett uttag. */
export const goalContributions = sqliteTable(
  "goal_contributions",
  {
    id: text("id").primaryKey(),
    goalId: text("goal_id")
      .notNull()
      .references(() => savingsGoals.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    amountMinor: integer("amount_minor").notNull(),
  },
  (t) => [
    check("goal_contributions_date", isoDate("date")),
    check("goal_contributions_amount", sql`amount_minor <> 0`),
    index("goal_contributions_goal_date").on(t.goalId, t.date),
  ],
);

/**
 * Planerad föräldraledighet (KK-23). Uppskattningen räknas i domänen (`estimateLeaveIncome`) och sparas
 * inte. Ett manuellt nettobelopp per månad vinner över uppskattningen (KK-23-B). Ingen ägare: appen har
 * en enda användare (KK-28).
 */
export const leavePeriods = sqliteTable(
  "leave_periods",
  {
    id: text("id").primaryKey(),
    fromDate: text("from_date").notNull(),
    toDate: text("to_date").notNull(),
    /** 0–7, halva dagar tillåtna. */
    daysPerWeek: real("days_per_week").notNull(),
    sgiAnnualMinor: integer("sgi_annual_minor").notNull(),
    employerTopupPct: real("employer_topup_pct").notNull().default(0),
    /** Anges av användaren (antagande A-9). */
    taxRatePct: real("tax_rate_pct").notNull(),
    overrideNetMonthlyMinor: integer("override_net_monthly_minor"),
    createdAt: createdAt(),
  },
  () => [
    check("leave_periods_from", isoDate("from_date")),
    check("leave_periods_to", isoDate("to_date")),
    check("leave_periods_order", sql`to_date >= from_date`),
    check("leave_periods_days", sql`days_per_week BETWEEN 0 AND 7`),
    check("leave_periods_sgi", sql`sgi_annual_minor >= 0`),
    check("leave_periods_topup", sql`employer_topup_pct BETWEEN 0 AND 100`),
    check("leave_periods_tax", sql`tax_rate_pct BETWEEN 0 AND 100`),
    check("leave_periods_override", sql`override_net_monthly_minor IS NULL OR override_net_monthly_minor >= 0`),
  ],
);

/**
 * Försäkringskassans parametrar per år (antagande A-5). Läggs in med en migrering per år, med källan
 * angiven. Saknas ett år använder domänen det senaste och varnar.
 */
export const incomeParameters = sqliteTable(
  "income_parameters",
  {
    year: integer("year").primaryKey(),
    priceBaseAmountMinor: integer("price_base_amount_minor").notNull(),
    sgiCapMultiplier: real("sgi_cap_multiplier").notNull(),
    benefitRate: real("benefit_rate").notNull(),
    sgiFactor: real("sgi_factor").notNull(),
    sourceUrl: text("source_url").notNull(),
  },
  () => [
    check("income_parameters_year", sql`year BETWEEN 2000 AND 2100`),
    check("income_parameters_price_base", sql`price_base_amount_minor > 0`),
    check("income_parameters_cap", sql`sgi_cap_multiplier > 0`),
    check("income_parameters_rate", sql`benefit_rate > 0 AND benefit_rate <= 1`),
    check("income_parameters_factor", sql`sgi_factor > 0 AND sgi_factor <= 1`),
    check("income_parameters_source", sql`source_url LIKE 'https://%'`),
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