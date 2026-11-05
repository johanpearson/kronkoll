// Enhetens Web Push-prenumeration (KK-27): det webbläsaren gör, samlat här så att testerna kan ersätta
// det. Utan service worker, PushManager eller Notification (t.ex. Safari på iPhone utan att appen är
// installerad på hemskärmen) går det inte att få notiser, och då säger `available` nej.

export interface DeviceSubscription {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
}

export interface PushDevice {
  /** Om enheten kan ta emot notiser just nu. */
  available(): Promise<boolean>;
  /** Enhetens nuvarande prenumeration, eller null. */
  current(): Promise<DeviceSubscription | null>;
  /** Ber om lov och prenumererar. "denied" om användaren sagt nej. */
  subscribe(publicKey: string): Promise<DeviceSubscription | "denied">;
  /** Slutar prenumerera och ger adressen som togs bort, eller null om det inte fanns någon. */
  unsubscribe(): Promise<string | null>;
}

const TOPICS_KEY = "kronkoll.push-topics";

/** Valda notistyper på den här enheten. Servern har samma lista; här finns den för att visa reglagen. */
export const storedTopics = {
  get(): string[] | null {
    try {
      const value: unknown = JSON.parse(window.localStorage.getItem(TOPICS_KEY) ?? "null");
      return Array.isArray(value) && value.every((t) => typeof t === "string") ? value : null;
    } catch {
      return null;
    }
  },
  set(topics: readonly string[]): void {
    window.localStorage.setItem(TOPICS_KEY, JSON.stringify(topics));
  },
};

function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function toDevice(subscription: PushSubscription): DeviceSubscription | null {
  const json = subscription.toJSON();
  const { p256dh, auth } = json.keys ?? {};
  return json.endpoint && p256dh && auth ? { endpoint: json.endpoint, keys: { p256dh, auth } } : null;
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return null;
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}

export const pushDevice: PushDevice = {
  async available() {
    return (await registration().catch(() => null)) !== null;
  },
  async current() {
    const reg = await registration();
    const sub = await reg?.pushManager.getSubscription();
    return sub ? toDevice(sub) : null;
  },
  async subscribe(publicKey) {
    const reg = await registration();
    if (!reg || (await Notification.requestPermission()) !== "granted") return "denied";
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromBase64url(publicKey) });
    return toDevice(sub) ?? "denied";
  },
  async unsubscribe() {
    const sub = await (await registration())?.pushManager.getSubscription();
    if (!sub) return null;
    await sub.unsubscribe();
    return sub.endpoint;
  },
};
