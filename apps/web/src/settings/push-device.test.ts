// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { browser } from "../browser.ts";
import { pushDevice, storedTopics } from "./push-device.ts";

/** Påhittad prenumeration som webbläsaren skulle ge (KK-13). */
function browserSubscription(endpoint = "https://web.push.apple.com/exempel", keys: Record<string, string> | null = { p256dh: "BKEY", auth: "AUTH" }) {
  return { endpoint, unsubscribe: vi.fn(() => Promise.resolve(true)), toJSON: () => ({ endpoint, ...(keys ? { keys } : {}) }) };
}

function stubBrowser(options: { registered?: boolean; existing?: ReturnType<typeof browserSubscription> | null; permission?: string } = {}) {
  const created = browserSubscription();
  const pushManager = {
    getSubscription: vi.fn(() => Promise.resolve(options.existing ?? null)),
    subscribe: vi.fn(() => Promise.resolve(created)),
  };
  vi.stubGlobal("PushManager", function PushManager() {});
  vi.stubGlobal("Notification", { requestPermission: vi.fn(() => Promise.resolve(options.permission ?? "granted")) });
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { getRegistration: () => Promise.resolve(options.registered === false ? undefined : { pushManager }) },
  });
  return { pushManager, created };
}

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "serviceWorker");
  window.localStorage.clear();
});

describe("enhetens push-prenumeration (KK-27)", () => {
  it("utan service worker eller PushManager går det inte att få notiser", async () => {
    expect(await pushDevice.available()).toBe(false);
    stubBrowser({ registered: false });
    expect(await pushDevice.available()).toBe(false);
    expect(await pushDevice.current()).toBeNull();
    expect(await pushDevice.unsubscribe()).toBeNull();
    expect(await pushDevice.subscribe("AQAB")).toBe("denied");
  });

  it("prenumererar med serverns nyckel efter att ha fått lov", async () => {
    const { pushManager } = stubBrowser();
    expect(await pushDevice.available()).toBe(true);
    expect(await pushDevice.current()).toBeNull();
    expect(await pushDevice.subscribe("AQ-_")).toEqual({ endpoint: "https://web.push.apple.com/exempel", keys: { p256dh: "BKEY", auth: "AUTH" } });
    expect(pushManager.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: Uint8Array.of(1, 15, 191) });
  });

  it("nekat lov eller en prenumeration utan nycklar ger denied", async () => {
    stubBrowser({ permission: "denied" });
    expect(await pushDevice.subscribe("AQAB")).toBe("denied");
    const { pushManager } = stubBrowser();
    pushManager.subscribe.mockResolvedValueOnce(browserSubscription("https://web.push.apple.com/x", null));
    expect(await pushDevice.subscribe("AQAB")).toBe("denied");
  });

  it("läser och avslutar en befintlig prenumeration", async () => {
    const existing = browserSubscription();
    stubBrowser({ existing });
    expect(await pushDevice.current()).toEqual({ endpoint: existing.endpoint, keys: { p256dh: "BKEY", auth: "AUTH" } });
    expect(await pushDevice.unsubscribe()).toBe(existing.endpoint);
    expect(existing.unsubscribe).toHaveBeenCalled();
  });
});

describe("valda typer på enheten", () => {
  it("sparas och läses, och skräp ger null", () => {
    expect(storedTopics.get()).toBeNull();
    storedTopics.set(["consent"]);
    expect(storedTopics.get()).toEqual(["consent"]);
    window.localStorage.setItem("kronkoll.push-topics", "{trasig");
    expect(storedTopics.get()).toBeNull();
    window.localStorage.setItem("kronkoll.push-topics", "[1]");
    expect(storedTopics.get()).toBeNull();
  });
});

describe("logga ut och rensa enheten (KK-35)", () => {
  it("avslutar push-prenumerationen och säger till servern innan resten rensas", async () => {
    const existing = browserSubscription();
    stubBrowser({ existing });
    const calls: { method: string | undefined; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ method: init?.method, body: JSON.parse(typeof init?.body === "string" ? init.body : "null") as unknown });
        return Promise.resolve(new Response(null, { status: 204 }));
      }),
    );
    vi.stubGlobal("caches", { keys: () => Promise.resolve([]), delete: () => Promise.resolve(true) });
    vi.stubGlobal("indexedDB", { databases: () => Promise.resolve([]) });
    window.localStorage.setItem("kronkoll.push-topics", '["consent"]');
    await browser.clearDevice();
    expect(existing.unsubscribe).toHaveBeenCalled();
    expect(calls).toEqual([{ method: "DELETE", body: { endpoint: existing.endpoint } }]);
    expect(window.localStorage.length).toBe(0);
  });
});
