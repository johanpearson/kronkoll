/**
 * Skickar notiser med Web Push (KK-27, D-notify) och uppfyller domänens `Notifier`. Varje enhet som
 * valt notistypen får en krypterad notis. En prenumeration som push-tjänsten säger finns inte längre
 * (404 eller 410) tas bort (V-i-push). Fel loggas av anroparen som antal, aldrig adresser eller text.
 */
import type { Notice, NotificationTopic, Notifier } from "@kronkoll/domain";
import { subscribedTo } from "@kronkoll/domain";
import { fromBase64url } from "./base64url.ts";
import { encryptPayload, type PushKeys } from "./encrypt.ts";
import type { Vapid } from "./vapid.ts";

export interface StoredPushSubscription extends PushKeys {
  readonly id: string;
  readonly endpoint: string;
  readonly topics: readonly NotificationTopic[];
}

export interface PushSubscriptionStore {
  list(): Promise<readonly StoredPushSubscription[]>;
  remove(id: string): Promise<void>;
}

export type PushResult = "sent" | "gone" | "failed";

export interface PushTally {
  readonly sent: number;
  readonly gone: number;
  readonly failed: number;
}

export interface WebPushOptions {
  readonly vapid: Vapid;
  readonly fetch: (input: string, init: RequestInit) => Promise<Response>;
}

/** En notis som inte levererats inom ett dygn är inte längre intressant. */
const TTL_SECONDS = 24 * 60 * 60;

/** Push-tjänsterna i de webbläsare appen stöder. Andra adresser anropas aldrig, så att API:t inte kan styras mot godtyckliga servrar. */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/u, /^(.+\.)?push\.apple\.com$/u, /^(.+\.)?push\.services\.mozilla\.com$/u, /^(.+\.)?notify\.windows\.com$/u];

export function isPushEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 1024) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.port === "" && url.username === "" && PUSH_HOSTS.some((host) => host.test(url.hostname));
  } catch {
    return false;
  }
}

/** Nycklarna webbläsaren gav vid prenumerationen: en P-256-nyckel och en hemlighet på 16 byte. */
export function isPushKeys(value: unknown): value is PushKeys {
  if (typeof value !== "object" || value === null) return false;
  const { p256dh, auth } = value as Record<string, unknown>;
  if (typeof p256dh !== "string" || typeof auth !== "string" || p256dh.length > 100 || auth.length > 30) return false;
  try {
    const key = fromBase64url(p256dh);
    return key.length === 65 && key[0] === 4 && fromBase64url(auth).length === 16;
  } catch {
    return false;
  }
}

export async function sendPush(options: WebPushOptions, subscription: StoredPushSubscription, payload: string): Promise<PushResult> {
  if (!isPushEndpoint(subscription.endpoint)) return "gone";
  try {
    const body = await encryptPayload(payload, subscription);
    const response = await options.fetch(subscription.endpoint, {
      method: "POST",
      headers: {
        authorization: await options.vapid.authorization(subscription.endpoint),
        "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream",
        ttl: String(TTL_SECONDS),
        urgency: "normal",
      },
      body,
    });
    if (response.status === 404 || response.status === 410) return "gone";
    return response.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}

/** `send` uppfyller domänens port. `deliver` gör detsamma men säger hur det gick, för loggen. */
export interface WebPushNotifier extends Notifier {
  deliver(notice: Notice): Promise<PushTally>;
}

export function createWebPushNotifier(options: WebPushOptions & { readonly subscriptions: PushSubscriptionStore }): WebPushNotifier {
  async function deliver(notice: Notice): Promise<PushTally> {
    const payload = JSON.stringify({ title: notice.title, body: notice.body, tag: notice.tag, topic: notice.topic });
    const tally = { sent: 0, gone: 0, failed: 0 };
    for (const subscription of subscribedTo(await options.subscriptions.list(), notice.topic)) {
      const result = await sendPush(options, subscription, payload);
      tally[result] += 1;
      if (result === "gone") await options.subscriptions.remove(subscription.id);
    }
    return tally;
  }
  return {
    deliver,
    async send(notice) {
      await deliver(notice);
    },
  };
}
