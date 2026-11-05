/**
 * VAPID (RFC 8292): push-tjänsten får veta vem som skickar genom en kort JWT signerad med ES256.
 * Den privata nyckeln är en Worker-secret (VAPID_PRIVATE_KEY) och syns aldrig i fel eller loggar.
 */
import { fromBase64url, toBase64url } from "./base64url.ts";

export interface VapidOptions {
  /** Publik nyckel (P-256, okomprimerad, base64url). Samma som appen använder när den prenumererar. */
  readonly publicKey: string;
  /** Privat nyckel (32 byte, base64url). */
  readonly privateKey: string;
  /** Kontakt till ägaren av appen, `mailto:` eller `https:`. */
  readonly subject: string;
  /** Klocka i millisekunder. */
  readonly now: () => number;
}

export interface Vapid {
  /** Värdet för `Authorization` mot den push-tjänst som äger adressen. */
  authorization(endpoint: string): Promise<string>;
}

type Key = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

/** Högst 24 h enligt RFC 8292. 12 h ger marginal för klockor som går fel. */
const TTL_SECONDS = 12 * 60 * 60;
const encoder = new TextEncoder();

async function importPrivateKey(publicKey: Uint8Array, privateKey: string): Promise<Key> {
  try {
    const jwk = { kty: "EC", crv: "P-256", d: privateKey, x: toBase64url(publicKey.slice(1, 33)), y: toBase64url(publicKey.slice(33, 65)) };
    return await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  } catch {
    throw new Error("Ogiltig VAPID-nyckel (VAPID_PRIVATE_KEY)");
  }
}

export function createVapid(options: VapidOptions): Vapid {
  const publicKey = fromBase64url(options.publicKey);
  if (publicKey.length !== 65 || publicKey[0] !== 4) throw new Error("Ogiltig publik VAPID-nyckel (VAPID_PUBLIC_KEY)");
  if (!/^(mailto:|https:)/u.test(options.subject)) throw new Error("VAPID_SUBJECT ska börja med mailto: eller https:");
  let key: Promise<Key> | undefined;

  return {
    async authorization(endpoint) {
      key ??= importPrivateKey(publicKey, options.privateKey);
      const header = toBase64url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
      const claims = {
        aud: new URL(endpoint).origin,
        exp: Math.floor(options.now() / 1000) + TTL_SECONDS,
        sub: options.subject,
      };
      const input = `${header}.${toBase64url(encoder.encode(JSON.stringify(claims)))}`;
      // WebCrypto ger signaturen som r || s (64 byte), precis det format JWT kräver.
      const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await key, encoder.encode(input));
      return `vapid t=${input}.${toBase64url(new Uint8Array(signature))}, k=${options.publicKey}`;
    },
  };
}
