import { describe, expect, it } from "vitest";
import { fromBase64url, toBase64url } from "./base64url.ts";
import { encryptPayload } from "./encrypt.ts";
import { ecdhPair, newReceiver, receiverFrom } from "./test-receiver.ts";

// Testvektorn i RFC 8291, bilaga A. Nycklarna är publicerade exempel, inte hemligheter.
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  // auth_secret i RFC:n.
  uaRandom: "BTBZMqHH6r4Tts7J_aSIgg",
  message:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

describe("aes128gcm-kryptering (RFC 8291, V-i-push)", () => {
  it("ger exakt RFC 8291:s testvektor med samma salt och nyckelpar", async () => {
    const keyPair = await ecdhPair(RFC.asPrivate, RFC.asPublic);
    const body = await encryptPayload(RFC.plaintext, { p256dh: RFC.uaPublic, auth: RFC.uaRandom }, { salt: fromBase64url(RFC.salt), keyPair });
    expect(toBase64url(body)).toBe(RFC.message);
  });

  it("RFC:ns mottagare kan dekryptera vektorn", async () => {
    const ua = await ecdhPair(RFC.uaPrivate, RFC.uaPublic);
    const receiver = receiverFrom(ua.privateKey, ua.raw, fromBase64url(RFC.uaRandom));
    expect(await receiver.decrypt(fromBase64url(RFC.message))).toBe(RFC.plaintext);
  });

  it("en ny webbläsare kan dekryptera notisen, och varje kryptering är unik", async () => {
    const receiver = await newReceiver();
    const text = JSON.stringify({ title: "Budget överskriden", body: "Mat har passerat budget (104 %)" });
    const first = await encryptPayload(text, receiver);
    const second = await encryptPayload(text, receiver);
    expect(await receiver.decrypt(first)).toBe(text);
    expect(toBase64url(first)).not.toBe(toBase64url(second));
    expect(first.slice(16, 20)).toEqual(Uint8Array.of(0, 0, 16, 0));
    expect(first[20]).toBe(65);
  });

  it("tar emot 3993 byte men inte en byte till, så att kroppen ryms i 4096", async () => {
    const receiver = await newReceiver();
    const body = await encryptPayload("x".repeat(3993), receiver);
    expect(body.length).toBe(4096);
    await expect(encryptPayload("x".repeat(3994), receiver)).rejects.toThrow("Notisen är för lång");
  });

  it("avvisar felaktiga nycklar från webbläsaren", async () => {
    const receiver = await newReceiver();
    await expect(encryptPayload("x", { p256dh: receiver.p256dh.slice(0, 40), auth: receiver.auth })).rejects.toThrow("Ogiltig p256dh");
    await expect(encryptPayload("x", { p256dh: toBase64url(new Uint8Array(65)), auth: receiver.auth })).rejects.toThrow("Ogiltig p256dh");
    await expect(encryptPayload("x", { p256dh: receiver.p256dh, auth: "AAAA" })).rejects.toThrow("Ogiltig auth");
  });
});

describe("base64url", () => {
  it("avvisar tecken utanför alfabetet", () => {
    expect(() => fromBase64url("ab+c")).toThrow("Ogiltig base64url");
    expect(fromBase64url("AQI=")).toEqual(Uint8Array.of(1, 2));
  });
});
