/**
 * Regler för den schemalagda och manuella synken (KK-7, beslut D-sync). Rena funktioner som
 * orkestreringen i Workern använder: vilket datum hämtningen börjar på, när en manuell synk
 * är tillåten, hur bankfel klassas och hur en körning sammanfattas. Inga bankdata finns här,
 * bara antal och felkoder (KK-13).
 */
import type { ProviderErrorCode } from "./bank.ts";
import { addDays, parseDate } from "./calendar.ts";

/** Överlapp bakåt från senaste bokförda, så att sena bokningar fångas. */
export const SYNC_OVERLAP_DAYS = 10;
export const MANUAL_SYNC_INTERVAL_MINUTES = 15;
/** Antal misslyckade körningar i rad som ger notisen "Synk misslyckas". */
export const SYNC_FAILURE_NOTICE_AFTER = 3;

/** Startdatum för hämtningen, eller null första gången (adaptern hämtar då så långt banken tillåter). */
export function syncDateFrom(lastBookedDate: string | null): string | null {
  if (lastBookedDate === null) return null;
  parseDate(lastBookedDate);
  return addDays(lastBookedDate, -SYNC_OVERLAP_DAYS);
}

export type ManualSyncGate = { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number };

/** Får en manuell synk startas nu? Räknas från start av senaste manuella körningen. */
export function manualSyncGate(lastManualStartedAt: Date | null, now: Date): ManualSyncGate {
  if (lastManualStartedAt === null) return { allowed: true };
  const elapsedMs = now.getTime() - lastManualStartedAt.getTime();
  const intervalMs = MANUAL_SYNC_INTERVAL_MINUTES * 60_000;
  // Negativt värde betyder att klockan har gått bakåt: släpp hellre igenom än att låsa ute.
  if (elapsedMs < 0 || elapsedMs >= intervalMs) return { allowed: true };
  return { allowed: false, retryAfterSeconds: Math.ceil((intervalMs - elapsedMs) / 1000) };
}

export interface FailureClass {
  /** Sparas i SyncRun.error_code: bara A–Z, 0–9 och understreck, aldrig bankens svarstext. */
  readonly errorCode: string;
  /** expire_connection sätter kopplingen till expired, retry_next_run försöker igen nästa körning. */
  readonly action: "expire_connection" | "retry_next_run";
}

export function classifyProviderFailure(code: ProviderErrorCode): FailureClass {
  switch (code) {
    case "UNAUTHORIZED":
      return { errorCode: "CONSENT_EXPIRED", action: "expire_connection" };
    case "RATE_LIMITED":
      return { errorCode: "EB_429", action: "retry_next_run" };
    case "UNAVAILABLE":
      return { errorCode: "EB_UNAVAILABLE", action: "retry_next_run" };
    case "BAD_RESPONSE":
      return { errorCode: "EB_BAD_RESPONSE", action: "retry_next_run" };
    case "FAILED":
      return { errorCode: "EB_FAILED", action: "retry_next_run" };
  }
}

export type AccountSyncResult =
  | { readonly ok: true; readonly newCount: number; readonly updatedCount: number }
  | { readonly ok: false; readonly error: ProviderErrorCode };

export interface SyncRunSummary {
  readonly status: "ok" | "partial" | "failed";
  readonly newCount: number;
  readonly updatedCount: number;
  readonly errorCode: string | null;
}

/** Sammanfattning av en körning. Fel isoleras per konto, så de lyckade kontonas antal räknas alltid. */
export function summarizeSyncRun(results: readonly AccountSyncResult[]): SyncRunSummary {
  let newCount = 0;
  let updatedCount = 0;
  const failures: FailureClass[] = [];
  for (const result of results) {
    if (result.ok) {
      newCount += result.newCount;
      updatedCount += result.updatedCount;
    } else {
      failures.push(classifyProviderFailure(result.error));
    }
  }
  // Ett utgånget samtycke är det användaren måste agera på, så det går före andra fel.
  const shown = failures.find((f) => f.action === "expire_connection") ?? failures[0];
  const status = failures.length === 0 ? "ok" : failures.length === results.length ? "failed" : "partial";
  return { status, newCount, updatedCount, errorCode: shown?.errorCode ?? null };
}

export function nextConsecutiveFailures(previous: number, status: SyncRunSummary["status"]): number {
  return status === "failed" ? previous + 1 : 0;
}

/** Notisen skickas en gång, när gränsen nås, så att ihållande fel inte ger en notis vid varje körning. */
export function shouldNotifySyncFailure(consecutiveFailures: number): boolean {
  return consecutiveFailures === SYNC_FAILURE_NOTICE_AFTER;
}
