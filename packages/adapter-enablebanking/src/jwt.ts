/**
 * Signerar kortlivade JWT:er för Enable Banking med RS256 via WebCrypto (KK-5-B).
 * Fungerar i både Cloudflare Workers och Node, utan beroenden. Den privata nyckeln kommer
 * från en Worker-secret (EB_PRIVATE_KEY, PKCS#8 PEM) och skrivs aldrig ut i fel eller loggar.
 */

export interface JwtSignerOptions {
  /** Privat nyckel i PKCS#8 PEM-format (Worker-secret EB_PRIVATE_KEY). */
  readonly privateKeyPem: string;
  /** Enable Bankings application id (EB_APP_ID), används som `kid`. */
  readonly applicationId: string;
  /** Klocka i millisekunder, injiceras för testbarhet. */
  readonly now: () => number;
  /** Giltighetstid i sekunder, högst 300. */
  readonly ttlSeconds?: number;
}

export interface JwtSigner {
  sign(): Promise<string>;
}

/** Nyckeltypen från WebCrypto, oberoende av om koden körs i Workers eller Node. */
type CryptoKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

const MAX_TTL_SECONDS = 300;
const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function encodeJson(value: object): string {
  return base64url(encoder.encode(JSON.stringify(value)));
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  try {
    const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
    const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
    return await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  } catch {
    // Originalfelet kan innehålla delar av nyckeln – kasta ett eget, generiskt fel.
    throw new Error("Ogiltig privat nyckel för Enable Banking (EB_PRIVATE_KEY)");
  }
}

export function createJwtSigner(options: JwtSignerOptions): JwtSigner {
  if (options.applicationId === "") {
    throw new Error("EB_APP_ID saknas");
  }
  const ttl = Math.min(options.ttlSeconds ?? MAX_TTL_SECONDS, MAX_TTL_SECONDS);
  let key: Promise<CryptoKey> | undefined;

  return {
    async sign() {
      key ??= importPrivateKey(options.privateKeyPem);
      const iat = Math.floor(options.now() / 1000);
      const header = encodeJson({ typ: "JWT", alg: "RS256", kid: options.applicationId });
      const payload = encodeJson({ iss: "enablebanking.com", aud: "api.enablebanking.com", iat, exp: iat + ttl });
      const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await key, encoder.encode(`${header}.${payload}`));
      return `${header}.${payload}.${base64url(new Uint8Array(signature))}`;
    },
  };
}
