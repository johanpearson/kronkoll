/**
 * Web Push i D1 (KK-27, D-notify): prenumerationerna per enhet och vilka notiser som redan har
 * skickats. Prenumerationerna har samma form som adapter-webpush behöver för att skicka.
 */
import type { D1Database } from "@cloudflare/workers-types";
import { parseTopics, type NotificationTopic } from "@kronkoll/domain";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { pushSubscriptions, sentNotices } from "./schema.ts";

export interface PushSubscriptionRecord {
  readonly id: string;
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly topics: readonly NotificationTopic[];
}

/** Kolumnen är alltid en JSON-lista (CHECK). Okända typer ger en tom lista, så att inget skickas av misstag. */
function topicsFrom(json: string): NotificationTopic[] {
  return parseTopics(JSON.parse(json)) ?? [];
}

export function pushRepository(d1: D1Database) {
  const db = drizzle(d1);

  const sent = async (kind: "budget" | "consent", scope: string) =>
    (
      await db
        .select({ item: sentNotices.item })
        .from(sentNotices)
        .where(and(eq(sentNotices.kind, kind), eq(sentNotices.scope, scope)))
        .orderBy(asc(sentNotices.item))
        .all()
    ).map((r) => r.item);

  const mark = async (kind: "budget" | "consent", scope: string, items: readonly string[]) => {
    if (items.length === 0) return;
    await db
      .insert(sentNotices)
      .values(items.map((item) => ({ kind, scope, item })))
      .onConflictDoNothing()
      .run();
  };

  return {
    /** Alla prenumerationer i den ordning de lades till. */
    async list(): Promise<PushSubscriptionRecord[]> {
      const rows = await db
        .select({ id: pushSubscriptions.id, endpoint: pushSubscriptions.endpoint, p256dh: pushSubscriptions.p256dh, auth: pushSubscriptions.auth, topics: pushSubscriptions.topics })
        .from(pushSubscriptions)
        .orderBy(asc(pushSubscriptions.createdAt), asc(pushSubscriptions.id))
        .all();
      return rows.map((row) => ({ ...row, topics: topicsFrom(row.topics) }));
    },

    /** Sparar prenumerationen. Finns adressen redan uppdateras den raden. Returnerar radens id. */
    async save(subscription: PushSubscriptionRecord): Promise<string> {
      const { id, endpoint, p256dh, auth } = subscription;
      const topics = JSON.stringify(subscription.topics);
      const row = await db
        .insert(pushSubscriptions)
        .values({ id, endpoint, p256dh, auth, topics })
        .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { p256dh, auth, topics } })
        .returning({ id: pushSubscriptions.id })
        .get();
      return row.id;
    },

    /** Falskt om prenumerationen inte fanns. */
    async remove(id: string): Promise<boolean> {
      return (await d1.prepare(`DELETE FROM push_subscriptions WHERE id = ?`).bind(id).run()).meta.changes > 0;
    },

    /** När enheten själv slutar prenumerera vet den bara sin adress. */
    async removeByEndpoint(endpoint: string): Promise<boolean> {
      return (await d1.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).bind(endpoint).run()).meta.changes > 0;
    },

    /** Kategorier som redan fått en budgetnotis i perioden. */
    budgetNoticesSent: (period: string) => sent("budget", period),
    markBudgetNoticesSent: (period: string, categoryIds: readonly string[]) => mark("budget", period, categoryIds),

    /** Gränser (14, 3, 0) som redan fått en påminnelse för samtycket, i stigande ordning. */
    async consentRemindersSent(connectionId: string, consentExpiresOn: string): Promise<number[]> {
      return (await sent("consent", `${connectionId}:${consentExpiresOn}`)).map(Number).sort((a, b) => a - b);
    },
    markConsentRemindersSent: (connectionId: string, consentExpiresOn: string, limits: readonly number[]) =>
      mark("consent", `${connectionId}:${consentExpiresOn}`, limits.map(String)),
  };
}
