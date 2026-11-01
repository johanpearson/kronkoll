/**
 * Samtyckets livscykel (KK-8, KK-27-B, flödet F-conn-state). Banken ger ett samtycke som gäller
 * till ett visst datum. När det är 14 dagar eller färre kvar visas en banner, och påminnelser
 * skickas 14, 3 och 0 dagar före. Texterna innehåller aldrig belopp eller kontonummer.
 */
import { daysBetween, parseDate } from "./calendar.ts";
import { formatDateShort } from "./format.ts";

export type ConnectionStatus = "pending_auth" | "active" | "expiring" | "expired" | "revoked" | "deleted";

export const EXPIRING_WITHIN_DAYS = 14;
export const REMINDER_DAYS: readonly number[] = [14, 3, 0];

export interface ConsentStatusInput {
  readonly status: ConnectionStatus;
  /** Sista dagen samtycket gäller, som svensk kalenderdag. */
  readonly consentExpiresOn: string | null;
  readonly today: string;
  /** Banken svarade 401 eller liknande på senaste anropet. */
  readonly bankRejected: boolean;
}

/** Status för en koppling vid dagens datum. Bara aktiva och snart utgående kopplingar ändras. */
export function consentStatus(input: ConsentStatusInput): ConnectionStatus {
  const { status } = input;
  if (status === "pending_auth" || status === "revoked" || status === "deleted" || status === "expired") return status;
  if (input.bankRejected) return "expired";
  if (input.consentExpiresOn === null) return "active";
  const daysLeft = daysBetween(input.today, input.consentExpiresOn);
  if (daysLeft < 0) return "expired";
  return daysLeft <= EXPIRING_WITHIN_DAYS ? "expiring" : "active";
}

export interface ReminderInput {
  readonly consentExpiresOn: string | null;
  readonly today: string;
  /** Gränser (14, 3, 0) som redan har fått en påminnelse för det här samtycket. */
  readonly alreadySent: readonly number[];
}

export interface DueReminder {
  readonly daysLeft: number;
  /** Gränser att markera som skickade, så att samma påminnelse aldrig skickas igen. */
  readonly markSent: readonly number[];
}

/**
 * Vilken påminnelse som ska skickas i dag, om någon. Har en synk missats skickas en enda
 * påminnelse med rätt antal dagar kvar, och alla passerade gränser markeras.
 */
export function dueConsentReminder(input: ReminderInput): DueReminder | null {
  if (input.consentExpiresOn === null) return null;
  const daysLeft = daysBetween(input.today, input.consentExpiresOn);
  if (daysLeft < 0) return null;
  const sent = new Set(input.alreadySent);
  const markSent = REMINDER_DAYS.filter((limit) => daysLeft <= limit && !sent.has(limit));
  return markSent.length > 0 ? { daysLeft, markSent } : null;
}

/** Text för notis och banner, t.ex. "Kopplingen till Skandia går ut om 3 dagar (4 nov. 2026)." */
export function consentReminderText(bankName: string, daysLeft: number, consentExpiresOn: string): string {
  parseDate(consentExpiresOn);
  const when = daysLeft === 0 ? "i dag" : daysLeft === 1 ? "i morgon" : `om ${String(daysLeft)} dagar`;
  return `Kopplingen till ${bankName} går ut ${when} (${formatDateShort(consentExpiresOn)}). Koppla om i appen.`;
}
