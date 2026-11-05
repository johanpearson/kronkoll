// Notiser via Web Push (KK-27, D-notify): budget överskriden och upprepade synkfel efter synken, och
// samtyckespåminnelser 14, 3 och 0 dagar före (KK-27-B). Domänen bestämmer vad som sägs och när
// (domain/notify). En notis markeras som skickad innan den skickas, så att den skickas högst en gång även
// om leveransen misslyckas. Bannern i appen finns alltid kvar (R-5). Loggen får bara typ och antal.
import { budgetRepository, categoryRepository, overviewRepository, pushRepository, settingsRepository } from "@kronkoll/adapter-d1";
import { createVapid, createWebPushNotifier, type PushTally } from "@kronkoll/adapter-webpush";
import {
  budgetByMainCategory,
  budgetOverNotices,
  consentNotice,
  currentBudgetPeriod,
  dueConsentReminder,
  subscribedTo,
  syncFailureNotice,
  todayInStockholm,
  type Clock,
  type Notice,
  type NotificationTopic,
} from "@kronkoll/domain";
import type { Logger } from "@kronkoll/logging";

/** VAPID-nycklarna sätts med `wrangler secret put`, aldrig i repot (D-secrets). */
export interface PushEnv {
  DB: D1Database;
  /** Publik VAPID-nyckel (P-256, base64url). Inte hemlig, men sätts tillsammans med den privata. */
  VAPID_PUBLIC_KEY?: string | undefined;
  /** Secret: privat VAPID-nyckel (base64url). */
  VAPID_PRIVATE_KEY?: string | undefined;
}

/** Den publika nyckeln, eller null om Web Push inte är konfigurerat. */
export function vapidPublicKey(env: PushEnv): string | null {
  return env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY ? env.VAPID_PUBLIC_KEY : null;
}

/** Det som levererar en notis till enheterna som valt dess typ. */
export interface PushSender {
  deliver(notice: Notice): Promise<PushTally>;
}

interface NotifyDeps {
  readonly logger: Logger;
  readonly clock: Clock;
}

/** Web Push i drift, eller null när VAPID-nycklarna saknas eller är fel. */
export function webPushFrom(env: PushEnv & { APP_ORIGIN?: string | undefined }): PushSender | null {
  const publicKey = vapidPublicKey(env);
  if (publicKey === null || !env.VAPID_PRIVATE_KEY || !env.APP_ORIGIN) return null;
  try {
    // Kontakten till push-tjänsten är appens adress, så att ingen e-postadress hamnar i repot.
    const vapid = createVapid({ publicKey, privateKey: env.VAPID_PRIVATE_KEY, subject: env.APP_ORIGIN, now: () => Date.now() });
    return createWebPushNotifier({ vapid, fetch: (input, init) => fetch(input, init), subscriptions: pushRepository(env.DB) });
  } catch {
    return null;
  }
}

async function wants(db: D1Database, topic: NotificationTopic): Promise<boolean> {
  return subscribedTo(await pushRepository(db).list(), topic).length > 0;
}

async function deliver(sender: PushSender, notice: Notice, logger: Logger): Promise<void> {
  const tally = await sender.deliver(notice);
  logger.info("push.sent", { kind: notice.topic, count: tally.sent, removed_count: tally.gone, error_code: tally.failed > 0 ? "FAILED" : null });
}

/** Budgetnotiser för den pågående perioden, högst en per kategori och period (KK-27-A). */
export async function notifyBudgetOver(db: D1Database, deps: NotifyDeps, sender: PushSender): Promise<void> {
  if (!(await wants(db, "budget_over"))) return;
  const { budgetPeriodStartDay } = await settingsRepository(db).get();
  const period = currentBudgetPeriod(deps.clock, budgetPeriodStartDay);
  const budgets = budgetRepository(db);
  const push = pushRepository(db);
  const [{ transactions, splits }, lines, categories, alreadySent] = await Promise.all([
    budgets.actuals(period),
    budgets.lines(period.key),
    categoryRepository(db).list(),
    push.budgetNoticesSent(period.key),
  ]);
  const budget = budgetByMainCategory({ period, transactions, splits, categories, lines });
  const notices = budgetOverNotices({ budget, names: new Map(categories.map((c) => [c.id, c.name])), alreadySent, budgeted: lines.map((l) => l.categoryId) });
  await push.markBudgetNoticesSent(period.key, notices.map((n) => n.categoryId));
  for (const { notice } of notices) await deliver(sender, notice, deps.logger);
}

/** Synken mot banken har misslyckats flera gånger i rad (KK-7-B). */
export async function notifySyncFailure(db: D1Database, deps: NotifyDeps, sender: PushSender, connectionId: string, bankName: string | null): Promise<void> {
  if (!(await wants(db, "sync_failed"))) return;
  await deliver(sender, syncFailureNotice(connectionId, bankName ?? "banken"), deps.logger);
}

/** Påminnelser 14, 3 och 0 dagar innan samtycket går ut (KK-27-B), en gång per gräns och samtycke. */
export async function remindConsent(db: D1Database, deps: NotifyDeps, sender: PushSender): Promise<void> {
  if (!(await wants(db, "consent"))) return;
  const today = todayInStockholm(deps.clock);
  const push = pushRepository(db);
  for (const c of await overviewRepository(db).connections()) {
    if ((c.status !== "active" && c.status !== "expiring") || c.consentExpiresOn === null) continue;
    const alreadySent = await push.consentRemindersSent(c.id, c.consentExpiresOn);
    const due = dueConsentReminder({ consentExpiresOn: c.consentExpiresOn, today, alreadySent });
    if (!due) continue;
    await push.markConsentRemindersSent(c.id, c.consentExpiresOn, due.markSent);
    await deliver(sender, consentNotice(c.id, c.bank ?? "banken", due.daysLeft, c.consentExpiresOn), deps.logger);
  }
}
