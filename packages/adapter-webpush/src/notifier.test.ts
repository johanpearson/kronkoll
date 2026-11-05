import type { Notice } from "@kronkoll/domain";
import { describe, expect, it } from "vitest";
import { createWebPushNotifier, isPushEndpoint, isPushKeys, sendPush, type StoredPushSubscription, type WebPushOptions } from "./notifier.ts";
import { newReceiver, type Receiver } from "./test-receiver.ts";
import type { Vapid } from "./vapid.ts";

const vapid: Vapid = { authorization: (endpoint) => Promise.resolve(`vapid t=jwt-for-${new URL(endpoint).origin}, k=pub`) };

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

/** En lokal push-tjänst: svarar med givna statuskoder per adress och sparar anropen. */
function pushService(statusFor: (url: string) => number | Error = () => 201) {
  const calls: Call[] = [];
  const options: WebPushOptions = {
    vapid,
    fetch: (url, init) => {
      calls.push({ url, init });
      const status = statusFor(url);
      return status instanceof Error ? Promise.reject(status) : Promise.resolve(new Response(null, { status }));
    },
  };
  return { calls, options };
}

const subscription = (receiver: Receiver, id: string, topics: StoredPushSubscription["topics"] = ["budget_over"]): StoredPushSubscription => ({
  id,
  endpoint: `https://fcm.googleapis.com/fcm/send/${id}`,
  p256dh: receiver.p256dh,
  auth: receiver.auth,
  topics,
});

const notice: Notice = { topic: "budget_over", title: "Budget överskriden", body: "Mat har passerat budget (104 %)", tag: "budget:2026-11:mat" };

describe("adresser till push-tjänster", () => {
  it.each([
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://web.push.apple.com/QH3",
    "https://updates.push.services.mozilla.com/wpush/v2/x",
    "https://wns2-db5p.notify.windows.com/w/?token=x",
  ])("tar emot %s", (url) => {
    expect(isPushEndpoint(url)).toBe(true);
  });

  it.each([
    "http://fcm.googleapis.com/fcm/send/abc",
    "https://fcm.googleapis.com:8443/x",
    "https://user@fcm.googleapis.com/x",
    "https://evil.example/fcm.googleapis.com",
    "https://fcm.googleapis.com.evil.example/x",
    "https://evilpush.apple.com/x",
    "inte en adress",
    `https://fcm.googleapis.com/${"a".repeat(1024)}`,
    42,
  ])("avvisar %s", (url) => {
    expect(isPushEndpoint(url)).toBe(false);
  });
});

describe("nycklar från webbläsaren", () => {
  it("tar emot riktiga nycklar och avvisar fel längd, typ och tecken", async () => {
    const r = await newReceiver();
    expect(isPushKeys({ p256dh: r.p256dh, auth: r.auth })).toBe(true);
    expect(isPushKeys({ p256dh: r.p256dh.slice(0, 40), auth: r.auth })).toBe(false);
    expect(isPushKeys({ p256dh: r.p256dh, auth: "AAAA" })).toBe(false);
    expect(isPushKeys({ p256dh: `${r.p256dh}${"A".repeat(20)}`, auth: r.auth })).toBe(false);
    expect(isPushKeys({ p256dh: r.p256dh, auth: `${r.auth}${"A".repeat(10)}` })).toBe(false);
    expect(isPushKeys({ p256dh: "!!", auth: r.auth })).toBe(false);
    expect(isPushKeys({ p256dh: 1, auth: r.auth })).toBe(false);
    expect(isPushKeys({ p256dh: r.p256dh, auth: 1 })).toBe(false);
    expect(isPushKeys(null)).toBe(false);
    expect(isPushKeys("nycklar")).toBe(false);
  });
});

describe("skicka en notis (V-i-push)", () => {
  it("skickar en krypterad kropp med VAPID och rätt huvuden, och mottagaren kan läsa den", async () => {
    const receiver = await newReceiver();
    const { calls, options } = pushService();
    expect(await sendPush(options, subscription(receiver, "s1"), "hej")).toBe("sent");
    const [call] = calls;
    expect(call?.url).toBe("https://fcm.googleapis.com/fcm/send/s1");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.headers).toEqual({
      authorization: "vapid t=jwt-for-https://fcm.googleapis.com, k=pub",
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: "86400",
      urgency: "normal",
    });
    expect(await receiver.decrypt(call?.init.body as Uint8Array)).toBe("hej");
  });

  it.each([
    [200, "sent"],
    [202, "sent"],
    [404, "gone"],
    [410, "gone"],
    [413, "failed"],
    [429, "failed"],
    [500, "failed"],
  ] as const)("svar %i ger %s", async (status, expected) => {
    const { options } = pushService(() => status);
    expect(await sendPush(options, subscription(await newReceiver(), "s1"), "hej")).toBe(expected);
  });

  it("nätverksfel ger failed, och en adress som inte är en push-tjänst anropas aldrig", async () => {
    const receiver = await newReceiver();
    const failing = pushService(() => new Error("nätet"));
    expect(await sendPush(failing.options, subscription(receiver, "s1"), "hej")).toBe("failed");
    const service = pushService();
    expect(await sendPush(service.options, { ...subscription(receiver, "s2"), endpoint: "https://evil.example/x" }, "hej")).toBe("gone");
    expect(service.calls).toEqual([]);
  });
});

describe("Notifier med Web Push (KK-27)", () => {
  it("skickar bara till enheter som valt typen, tar bort borttagna prenumerationer och räknar utfallet", async () => {
    const [a, b, c, d] = await Promise.all([newReceiver(), newReceiver(), newReceiver(), newReceiver()]);
    const subs = [
      subscription(a, "ok"),
      subscription(b, "gone"),
      subscription(c, "trasig"),
      subscription(d, "annan", ["consent"]),
    ];
    const removed: string[] = [];
    const { calls, options } = pushService((url) => (url.endsWith("/gone") ? 410 : url.endsWith("/trasig") ? 500 : 201));
    const notifier = createWebPushNotifier({
      ...options,
      subscriptions: {
        list: () => Promise.resolve(subs),
        remove: (id) => {
          removed.push(id);
          return Promise.resolve();
        },
      },
    });

    expect(await notifier.deliver(notice)).toEqual({ sent: 1, gone: 1, failed: 1 });
    expect(removed).toEqual(["gone"]);
    expect(calls.map((x) => x.url.split("/").at(-1))).toEqual(["ok", "gone", "trasig"]);
    expect(JSON.parse(await a.decrypt(calls[0]?.init.body as Uint8Array))).toEqual({
      title: "Budget överskriden",
      body: "Mat har passerat budget (104 %)",
      tag: "budget:2026-11:mat",
      topic: "budget_over",
    });
  });

  it("send uppfyller domänens port och skickar likadant", async () => {
    const receiver = await newReceiver();
    const { calls, options } = pushService();
    const notifier = createWebPushNotifier({ ...options, subscriptions: { list: () => Promise.resolve([subscription(receiver, "s1")]), remove: () => Promise.resolve() } });
    await expect(notifier.send(notice)).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});
