// Web Push i workerd (V-i-push): kryptering och VAPID-signering körs i samma runtime som i drift, mot en
// lokal mottagare. Push-tjänsten ersätts av en fetch som sparar anropet; inget lämnar maskinen.
import { createVapid, createWebPushNotifier, type StoredPushSubscription } from "@kronkoll/adapter-webpush";
import { newReceiver, vapidKeys } from "@kronkoll/adapter-webpush/test-support";
import { describe, expect, it } from "vitest";

const b64urlDecode = (s: string) => Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

describe("Web Push i Workers-miljön (KK-27, V-i-push)", () => {
  it("mottagaren kan dekryptera notisen, VAPID-signaturen stämmer och 410 tar bort prenumerationen", async () => {
    const [receiver, gone, keys] = await Promise.all([newReceiver(), newReceiver(), vapidKeys()]);
    const subs: StoredPushSubscription[] = [
      { id: "s1", endpoint: "https://web.push.apple.com/enhet-1", p256dh: receiver.p256dh, auth: receiver.auth, topics: ["budget_over"] },
      { id: "s2", endpoint: "https://web.push.apple.com/enhet-2", p256dh: gone.p256dh, auth: gone.auth, topics: ["budget_over"] },
    ];
    const removed: string[] = [];
    const calls: { url: string; init: RequestInit }[] = [];
    const notifier = createWebPushNotifier({
      vapid: createVapid({ publicKey: keys.publicKey, privateKey: keys.privateKey, subject: "https://kronkoll-25e.pages.dev", now: () => Date.now() }),
      fetch: (url, init) => {
        calls.push({ url, init });
        return Promise.resolve(new Response(null, { status: url.endsWith("2") ? 410 : 201 }));
      },
      subscriptions: {
        list: () => Promise.resolve(subs),
        remove: (id) => {
          removed.push(id);
          return Promise.resolve();
        },
      },
    });

    const tally = await notifier.deliver({ topic: "budget_over", title: "Budget överskriden", body: "Mat har passerat budget (104 %)", tag: "budget:2026-11:mat" });

    expect(tally).toEqual({ sent: 1, gone: 1, failed: 0 });
    expect(removed).toEqual(["s2"]);
    const first = calls[0];
    expect(JSON.parse(await receiver.decrypt(first?.init.body as Uint8Array))).toMatchObject({ body: "Mat har passerat budget (104 %)" });
    const auth = (first?.init.headers as Record<string, string>).authorization ?? "";
    const [, token = ""] = /^vapid t=([^,]+), k=/u.exec(auth) ?? [];
    const [header = "", claims = "", signature = ""] = token.split(".");
    const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, keys.verifyKey, b64urlDecode(signature), new TextEncoder().encode(`${header}.${claims}`));
    expect(valid).toBe(true);
  });
});
