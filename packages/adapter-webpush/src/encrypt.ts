/**
 * Kryptering av Web Push-innehåll med aes128gcm (RFC 8188 och RFC 8291) via WebCrypto. Bara
 * webbläsaren som prenumererar har nyckeln, så push-tjänsten (Apple, Google, Mozilla) ser aldrig texten.
 */
import { concat, fromBase64url } from "./base64url.ts";

type Key = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
export interface EcKeyPair {
  readonly privateKey: Key;
  readonly publicKey: Key;
}

/** Ett record räcker för en notis. 4096 byte är också största kropp push-tjänsterna tar emot. */
const RECORD_SIZE = 4096;
/** Huvudet (86 byte), avslutande 0x02 och GCM-taggen (16 byte) ska rymmas i samma 4096 byte. */
const MAX_PLAINTEXT = RECORD_SIZE - 86 - 1 - 16;
const encoder = new TextEncoder();

export interface PushKeys {
  /** Webbläsarens publika nyckel (P-256, okomprimerad, base64url). */
  readonly p256dh: string;
  /** Webbläsarens autentiseringshemlighet (16 byte, base64url). */
  readonly auth: string;
}

/** Fast salt och nyckelpar ger samma utdata som RFC 8291:s testvektor. Bara för tester. */
export interface EncryptOverrides {
  readonly salt: Uint8Array;
  readonly keyPair: EcKeyPair;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

/** Nyckelns råa bytes. exportKey("raw") ger alltid en ArrayBuffer, men typen täcker även JWK. */
export async function rawKey(key: Key): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array((await crypto.subtle.exportKey("raw", key)) as ArrayBuffer);
}

/** Krypterar texten till en aes128gcm-kropp: salt, recordstorlek, avsändarens nyckel och chiffertext. */
export async function encryptPayload(plaintext: string, keys: PushKeys, overrides?: EncryptOverrides): Promise<Uint8Array<ArrayBuffer>> {
  const uaPublic = fromBase64url(keys.p256dh);
  const authSecret = fromBase64url(keys.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new RangeError("Ogiltig p256dh");
  if (authSecret.length !== 16) throw new RangeError("Ogiltig auth");
  const data = encoder.encode(plaintext);
  if (data.length > MAX_PLAINTEXT) throw new RangeError("Notisen är för lång");

  const keyPair = overrides?.keyPair ?? ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as EcKeyPair);
  const asPublic = await rawKey(keyPair.publicKey);
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  // Som variabel, eftersom Workers typer kallar fältet `$public` medan körmiljön och standarden använder `public`.
  const ecdh = { name: "ECDH", public: uaKey };
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(ecdh, keyPair.privateKey, 256));

  const ikm = await hkdf(authSecret, ecdhSecret, concat(encoder.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = overrides?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);

  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // 0x02 markerar sista recordet (RFC 8188), utan utfyllnad.
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, concat(data, Uint8Array.of(2))));
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  return concat(header, asPublic, cipher);
}
