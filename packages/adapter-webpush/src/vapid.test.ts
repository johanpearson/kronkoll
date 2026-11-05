import { describe, expect, it } from "vitest";
import { fromBase64url, toBase64url } from "./base64url.ts";
import { vapidKeys } from "./test-receiver.ts";
import { createVapid } from "./vapid.ts";

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);

const decode = (part: string) => JSON.parse(new TextDecoder().decode(fromBase64url(part))) as Record<string, unknown>;

describe("VAPID (RFC 8292, V-i-push)", () => {
  it("ger en giltig ES256-JWT för push-tjänstens origin och den publika nyckeln", async () => {
    const keys = await vapidKeys();
    const vapid = createVapid({ ...keys, subject: "mailto:agare@example.com", now: () => NOW });
    const value = await vapid.authorization("https://fcm.googleapis.com/fcm/send/abc:def");
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/u.exec(value);
    expect(match?.[4]).toBe(keys.publicKey);
    const [, header = "", claims = "", signature = ""] = match ?? [];
    expect(decode(header)).toEqual({ typ: "JWT", alg: "ES256" });
    expect(decode(claims)).toEqual({ aud: "https://fcm.googleapis.com", exp: NOW / 1000 + 12 * 3600, sub: "mailto:agare@example.com" });
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      keys.verifyKey,
      fromBase64url(signature),
      new TextEncoder().encode(`${header}.${claims}`),
    );
    expect(valid).toBe(true);
  });

  it("avvisar en felaktig publik nyckel och ett ämne som inte är mailto: eller https:", async () => {
    const keys = await vapidKeys();
    expect(() => createVapid({ ...keys, publicKey: keys.publicKey.slice(0, 40), subject: "mailto:a@b.se", now: () => NOW })).toThrow(
      "Ogiltig publik VAPID-nyckel (VAPID_PUBLIC_KEY)",
    );
    expect(() => createVapid({ ...keys, publicKey: toBase64url(new Uint8Array(65)), subject: "mailto:a@b.se", now: () => NOW })).toThrow("VAPID_PUBLIC_KEY");
    expect(() => createVapid({ ...keys, subject: "a@b.se", now: () => NOW })).toThrow("VAPID_SUBJECT ska börja med mailto: eller https:");
    expect(() => createVapid({ ...keys, subject: "https://kronkoll.example", now: () => NOW })).not.toThrow();
  });

  it("en trasig privat nyckel ger ett generiskt fel utan nyckeln", async () => {
    const keys = await vapidKeys();
    const vapid = createVapid({ ...keys, privateKey: "inte-en-nyckel", subject: "mailto:a@b.se", now: () => NOW });
    const error: unknown = await vapid.authorization("https://web.push.apple.com/x").catch((e: unknown) => e);
    expect(error).toEqual(new Error("Ogiltig VAPID-nyckel (VAPID_PRIVATE_KEY)"));
  });
});
