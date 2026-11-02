// Publikt API för domänlagret. Ren TypeScript utan beroenden (KK-14).
export { formatDateIso, formatDateShort, formatSek } from "./format.ts";
export { assertMinor, parseAmount, sumMinor } from "./money.ts";
export { addDays } from "./calendar.ts";
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
  TRANSFER_WINDOW_DAYS,
  type ClassifyTransfersInput,
  type OwnAccount,
  type TransferClassification,
  type TransferInput,
} from "./transfers.ts";
export { learnPattern, matchesWordPrefix, normalizeCounterparty } from "./normalize.ts";
export {
  applyRules,
  categorize,
  learnFromManualChoice,
  type CategorizableTransaction,
  type Categorization,
  type CategoryChange,
  type CategoryRule,
  type CategorySource,
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
  budgetOutcome,
  spendingByCategory,
  suggestFromAverage,
  suggestFromPrevious,
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
  ProviderError,
  type BankAccount,
  type BankAccountType,
  type BankDataProvider,
  type ProviderErrorCode,
  type ProviderTransaction,
  type TransactionPage,
} from "./bank.ts";
