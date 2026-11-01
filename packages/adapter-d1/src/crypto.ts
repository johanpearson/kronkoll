/**
 * Kryptering och hashning av det som inte får sparas i klartext (KK-11-C, D-secrets).
 *
 * Allt härleds från Worker-secreten SESSION_ENC_KEY (minst 32 slumpmässiga byte, base64) med
 * HKDF, så att samma hemlighet aldrig används till två saker:
 * - Enable Bankings session-id krypteras med AES-256-GCM och ett nytt slumpat IV varje gång.
 * - IBAN sparas bara som HMAC-SHA-256, så att ett konto känns igen vid koppla om (KK-8-B)
 *   utan att kontonumret finns i databasen.
 * Bara Web Crypto används, så koden fungerar i både Workern och Node.
 */

const FORMAT_VERSION = 1;
const IV_BYTES = 12;
const MIN_SECRET_BYTES = 32;
const SESSION_CONTEXT = new TextEncoder().encode("kronkoll/bank_connections.session_id");

type Key = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

export interface Keys {
  readonly sessionKey: Key;
  readonly ibanKey: Key;
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  let binary: string;
  try {
    binary = atob(text.trim());
  } catch {
    throw new RangeError("SESSION_ENC_KEY är inte giltig base64");
  }
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** Härleder nycklarna från SESSION_ENC_KEY. */
export async function deriveKeys(secretBase64: string): Promise<Keys> {
  const secret = fromBase64(secretBase64);
  if (secret.length < MIN_SECRET_BYTES) throw new RangeError("SESSION_ENC_KEY måste vara minst 32 byte");
  const master = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  const hkdf = (info: string) => ({
    name: "HKDF",
    hash: "SHA-256",
    salt: new Uint8Array(32),
    info: new TextEncoder().encode(info),
  });
  return {
    sessionKey: await crypto.subtle.deriveKey(hkdf("kronkoll/session-id/v1"), master, { name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]),
    ibanKey: await crypto.subtle.deriveKey(hkdf("kronkoll/iban/v1"), master, { name: "HMAC", hash: "SHA-256", length: 256 }, false, [
      "sign",
    ]),
  };
}

/** Krypterar ett session-id. Resultatet är version (1 byte) + IV (12 byte) + chiffertext. */
export async function encryptSessionId(keys: Keys, sessionId: string): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: SESSION_CONTEXT },
    keys.sessionKey,
    new TextEncoder().encode(sessionId),
  );
  const out = new Uint8Array(1 + IV_BYTES + cipher.byteLength);
  out[0] = FORMAT_VERSION;
  out.set(iv, 1);
  out.set(new Uint8Array(cipher), 1 + IV_BYTES);
  return out;
}

/** Dekrypterar ett session-id. Kastar om värdet har ändrats eller nyckeln är fel. */
export async function decryptSessionId(keys: Keys, sealed: Uint8Array): Promise<string> {
  if (sealed[0] !== FORMAT_VERSION || sealed.length <= 1 + IV_BYTES) throw new RangeError("Okänt format på krypterat session-id");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: sealed.slice(1, 1 + IV_BYTES), additionalData: SESSION_CONTEXT },
    keys.sessionKey,
    sealed.slice(1 + IV_BYTES),
  );
  return new TextDecoder().decode(plain);
}

const normalizeIban = (iban: string) => iban.replace(/\s+/gu, "").toUpperCase();

/** HMAC av IBAN som hex. Mellanslag och gemener spelar ingen roll. */
export async function hashIban(keys: Keys, iban: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", keys.ibanKey, new TextEncoder().encode(normalizeIban(iban)));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Kontonamn som får visas och sparas, t.ex. "Privatkonto ••7466". Långa sifferföljder i bankens
 * namn (ofta kontonumret) tas bort, och bara de fyra sista siffrorna i IBAN visas.
 */
export function maskAccountName(name: string, iban: string | null): string {
  const base = name.replace(/\d[\d\s-]{3,}\d/gu, "").replace(/\s+/gu, " ").trim() || "Konto";
  const digits = iban === null ? "" : normalizeIban(iban).replace(/\D/gu, "");
  return digits.length >= 4 ? `${base} ••${digits.slice(-4)}` : base;
}
