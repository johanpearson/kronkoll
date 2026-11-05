// Web Push i service workern (KK-27, D-notify). Servern skickar en krypterad JSON med titel, text, tag och
// typ; webbläsaren dekrypterar den innan händelsen `push` kommer hit. Texten visas som den är, som text
// och aldrig som HTML (KK-30). Ett tryck på notisen öppnar vyn som hör till typen.

export interface ShownNotice {
  readonly title: string;
  readonly options: { readonly body: string; readonly tag: string; readonly icon: string; readonly badge: string; readonly data: { readonly url: string } };
}

const ICON = "/icons/icon-192.png";
const MAX_TEXT = 300;

/** Vyn som öppnas för respektive typ. */
const TARGET: Readonly<Record<string, string>> = {
  budget_over: "/budget",
  sync_failed: "/installningar",
  consent: "/installningar",
};

const text = (value: unknown, fallback: string) => (typeof value === "string" && value.trim() !== "" ? value.slice(0, MAX_TEXT) : fallback);

/** Notisen att visa för ett push-meddelande. Okänt eller trasigt innehåll ger en neutral notis. */
export function noticeFrom(payload: string | null): ShownNotice {
  let body: unknown;
  try {
    body = payload === null ? null : JSON.parse(payload);
  } catch {
    body = null;
  }
  const b = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const topic = typeof b.topic === "string" ? b.topic : "";
  return {
    title: text(b.title, "Kronkoll"),
    options: {
      body: text(b.body, "Öppna appen för att se mer."),
      tag: text(b.tag, "kronkoll"),
      icon: ICON,
      badge: ICON,
      data: { url: TARGET[topic] ?? "/" },
    },
  };
}

/** Adressen att öppna när notisen trycks, alltid på appens egen origin. */
export function clickTarget(data: unknown, origin: string): string {
  const url = typeof data === "object" && data !== null ? (data as Record<string, unknown>).url : null;
  const path = typeof url === "string" && Object.values(TARGET).includes(url) ? url : "/";
  return new URL(path, origin).href;
}
