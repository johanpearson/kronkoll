/**
 * Notiser (KK-27, beslut D-notify). Domänen bestämmer vad som ska sägas och när, och en `Notifier`
 * (Web Push i adapter-webpush) levererar. Bannern i appen finns alltid kvar som baslinje (R-5).
 * Texterna innehåller aldrig belopp per transaktion, kontonummer eller banktext (KK-27-A, T-I3).
 */
import type { BudgetByMainCategory, BudgetFigures } from "./budget.ts";
import { consentReminderText } from "./consent.ts";
import { SYNC_FAILURE_NOTICE_AFTER } from "./sync.ts";

export type NotificationTopic = "consent" | "budget_over" | "sync_failed";

export const NOTIFICATION_TOPICS: readonly NotificationTopic[] = ["consent", "budget_over", "sync_failed"];

export interface Notice {
  readonly topic: NotificationTopic;
  readonly title: string;
  readonly body: string;
  /** En ny notis med samma tag ersätter den gamla på enheten. */
  readonly tag: string;
}

/** Porten för att skicka en notis till alla enheter som valt dess typ. */
export interface Notifier {
  send(notice: Notice): Promise<void>;
}

/** Valda notistyper från appen, utan dubbletter och i fast ordning. Null om något är fel. */
export function parseTopics(value: unknown): NotificationTopic[] | null {
  if (!Array.isArray(value)) return null;
  const known: readonly unknown[] = NOTIFICATION_TOPICS;
  if (!value.every((t) => known.includes(t))) return null;
  return NOTIFICATION_TOPICS.filter((t) => value.includes(t));
}

/** Prenumerationerna som har valt notistypen. */
export function subscribedTo<T extends { readonly topics: readonly NotificationTopic[] }>(subscriptions: readonly T[], topic: NotificationTopic): T[] {
  return subscriptions.filter((s) => s.topics.includes(topic));
}

export interface BudgetNoticeInput {
  readonly budget: BudgetByMainCategory;
  /** Kategoriernas namn per id. */
  readonly names: ReadonlyMap<string, string>;
  /** Kategorier som redan fått en budgetnotis i perioden. */
  readonly alreadySent: readonly string[];
}

export interface BudgetNotice {
  /** Markeras som skickad för perioden, så att samma kategori inte får en notis till. */
  readonly categoryId: string;
  readonly notice: Notice;
}

/**
 * Budgetnotiser för perioden (KK-27-A): huvudkategorier och underkategorier med egen budget som har
 * passerat budgeten och inte redan fått en notis i perioden. Bara procent visas, aldrig belopp.
 */
export function budgetOverNotices(input: BudgetNoticeInput): BudgetNotice[] {
  const sent = new Set(input.alreadySent);
  const all: BudgetFigures[] = input.budget.groups.flatMap((g) => [g, ...g.subcategories]);
  return all
    .filter((f) => f.over && !sent.has(f.categoryId))
    .map((f) => {
      const name = input.names.get(f.categoryId) ?? "En kategori";
      const percent = f.percent === null ? "" : ` (${String(f.percent)} %)`;
      return {
        categoryId: f.categoryId,
        notice: {
          topic: "budget_over",
          title: "Budget överskriden",
          body: `${name} har passerat budget${percent}`,
          tag: `budget:${input.budget.period}:${f.categoryId}`,
        },
      };
    });
}

/** Synken har misslyckats flera gånger i rad (KK-7-B). Felkoden visas i appen, inte i notisen. */
export function syncFailureNotice(connectionId: string, bankName: string): Notice {
  return {
    topic: "sync_failed",
    title: "Synken misslyckas",
    body: `Synken mot ${bankName} har misslyckats ${String(SYNC_FAILURE_NOTICE_AFTER)} gånger i rad. Öppna appen för att se mer.`,
    tag: `sync:${connectionId}`,
  };
}

/** Påminnelse 14, 3 och 0 dagar före samtycket går ut (KK-27-B), med samma text som bannern. */
export function consentNotice(connectionId: string, bankName: string, daysLeft: number, consentExpiresOn: string): Notice {
  return {
    topic: "consent",
    title: "Samtycket går snart ut",
    body: consentReminderText(bankName, daysLeft, consentExpiresOn),
    tag: `consent:${connectionId}`,
  };
}
