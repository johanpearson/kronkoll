// Publikt API för domänlagret. Ren TypeScript utan beroenden (KK-14).
export { formatDateIso, formatDateShort, formatSek } from "./format.ts";
export { assertMinor, parseAmount, sumMinor } from "./money.ts";
export { addDays, daysBetween } from "./calendar.ts";
export { fixedClock, stockholmDate, todayInStockholm, type Clock } from "./clock.ts";
export { easterSunday, isBankDay, previousBankDayOnOrBefore, swedishBankHolidays } from "./bankdays.ts";
export { budgetPeriodForKey, budgetPeriodOf, currentBudgetPeriod, weekStart, type BudgetPeriod } from "./period.ts";
export {
  reconcile,
  MATCH_WINDOW_DAYS,
  PENDING_GRACE_DAYS,
  type ImportedTransaction,
  type ReconcileInput,
  type ReconcileResult,
  type StoredTransaction,
  type TransactionStatus,
} from "./reconcile.ts";
export {
  classifyTransfers,
  excludeRuleHits,
  TRANSFER_WINDOW_DAYS,
  type ClassifyTransfersInput,
  type ExcludeRule,
  type OwnAccount,
  type TransferClassification,
  type TransferInput,
} from "./transfers.ts";
export { learnPattern, matchesWordPrefix, normalizeCounterparty } from "./normalize.ts";
export {
  applyAllRules,
  applyRules,
  ruleReach,
  categorize,
  learnFromManualChoice,
  matchingRule,
  patternChoices,
  ruleHits,
  ruleMatches,
  ruleKey,
  type CategorizableTransaction,
  type Categorization,
  type CategoryChange,
  type CategoryRule,
  type CategorySource,
  type RuleCondition,
  type RuleMatch,
  type RuleReach,
  type LearnInput,
  type LearnResult,
} from "./categorize.ts";
export {
  CATEGORY_TEMPLATE,
  TEMPLATE_RULES,
  addCategory,
  archiveCategory,
  mergeCategories,
  renameCategory,
  type AddCategoryInput,
  type Category,
  type CategoryKind,
  type MergeInput,
  type MergeResult,
} from "./categories.ts";
export { allocateByCategory, validateSplit, type Allocation, type SplitPart, type SplitResult } from "./split.ts";
export {
  EXPIRING_WITHIN_DAYS,
  REMINDER_DAYS,
  consentReminderText,
  consentStatus,
  dueConsentReminder,
  type ConnectionStatus,
  type ConsentStatusInput,
  type DueReminder,
  type ReminderInput,
} from "./consent.ts";
export {
  budgetByMainCategory,
  budgetOutcome,
  spendingByCategory,
  suggestFromAverage,
  suggestFromPrevious,
  type BudgetByMainCategory,
  type BudgetFigures,
  type BudgetGroup,
  type BudgetLineInput,
  type BudgetLineOutcome,
  type BudgetOutcome,
  type BudgetTransaction,
  type SpendingInput,
} from "./budget.ts";
export {
  leftToSpend,
  periodTotals,
  recentPeriods,
  totalBalance,
  trend,
  type LeftToSpend,
  type LeftToSpendInput,
  type OverviewAccount,
  type PeriodTotals,
} from "./overview.ts";
export {
  MANUAL_SYNC_INTERVAL_MINUTES,
  SYNC_FAILURE_NOTICE_AFTER,
  SYNC_OVERLAP_DAYS,
  classifyProviderFailure,
  manualSyncGate,
  nextConsecutiveFailures,
  shouldNotifySyncFailure,
  summarizeSyncRun,
  syncDateFrom,
  type AccountSyncResult,
  type FailureClass,
  type ManualSyncGate,
  type SyncRunSummary,
} from "./sync.ts";
export {
  syncConnection,
  type BalanceStore,
  type ConnectionSyncState,
  type SyncConnectionInput,
  type SyncConnectionOutcome,
  type SyncKind,
  type SyncRunLog,
} from "./sync-connection.ts";
export {
  runProviderContract,
  type ContractAccountReport,
  type ContractOptions,
  type ContractReport,
} from "./provider-contract.ts";
export {
  DEFAULT_MAX_PAGES,
  FIRST_SYNC_DAYS,
  syncAccount,
  type SyncAccountInput,
  type TransactionStore,
} from "./sync-account.ts";
export {
  type AuthorizationRequest,
  type BankConnector,
  type BankSession,
  ProviderError,
  type BankAccount,
  type BankAccountType,
  type BankDataProvider,
  type ProviderErrorCode,
  type ProviderTransaction,
  type TransactionPage,
} from "./bank.ts";
