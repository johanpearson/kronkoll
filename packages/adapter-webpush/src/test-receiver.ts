// Testmottagare för Web Push: en webbläsares nycklar och dekryptering enligt RFC 8291. Bara för tester.
import { concat, fromBase64url, toBase64url } from "./base64url.ts";
import { rawKey, type EcKeyPair } from "./encrypt.ts";

type Key = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
const encoder = new TextEncoder();

export interface Receiver {
  readonly p256dh: string;
  readonly auth: string;
  decrypt(body: Uint8Array): Promise<string>;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

export function receiverFrom(privateKey: Key, publicRaw: Uint8Array, authSecret: Uint8Array): Receiver {
  return {
    p256dh: toBase64url(publicRaw),
    auth: toBase64url(authSecret),
    async decrypt(body) {
      const salt = body.slice(0, 16);
      const idLength = body[20] ?? 0;
      const asPublic = body.slice(21, 21 + idLength);
      const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
      const ecdh = { name: "ECDH", public: asKey };
      const secret = new Uint8Array(await crypto.subtle.deriveBits(ecdh, privateKey, 256));
      const ikm = await hkdf(authSecret, secret, concat(encoder.encode("WebPush: info\0"), publicRaw, asPublic), 32);
      const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
      const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);
      const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
      const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aesKey, body.slice(21 + idLength)));
      if (plain.at(-1) !== 2) throw new Error("Saknar avslutande 0x02");
      return new TextDecoder().decode(plain.slice(0, -1));
    },
  };
}

export async function newReceiver(): Promise<Receiver> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as EcKeyPair;
  return receiverFrom(pair.privateKey, await rawKey(pair.publicKey), crypto.getRandomValues(new Uint8Array(16)));
}

/** Ett nyskapat VAPID-nyckelpar i samma format som Worker-secreten. */
export async function vapidKeys() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as EcKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  return {
    publicKey: toBase64url(await rawKey(pair.publicKey)),
    privateKey: jwk.d ?? "",
    verifyKey: pair.publicKey,
  };
}

/** Importerar ett ECDH-nyckelpar från base64url (privat d, publik okomprimerad). */
export async function ecdhPair(d: string, publicKey: string) {
  const raw = fromBase64url(publicKey);
  const jwk = { kty: "EC", crv: "P-256", d, x: toBase64url(raw.slice(1, 33)), y: toBase64url(raw.slice(33, 65)) };
  return {
    privateKey: await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]),
    publicKey: await crypto.subtle.importKey("raw", raw, { name: "ECDH", namedCurve: "P-256" }, true, []),
    raw,
  };
}
