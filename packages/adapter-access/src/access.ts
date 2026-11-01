/**
 * Validering av Cloudflare Access-JWT i API-workern (KK-2-B, hot T-S1).
 * Workern litar aldrig på att den bara nås via Access. Den verifierar signaturen mot
 * Access-teamets publika nycklar (JWKS) och kontrollerar utfärdare, aud, tid och e-post.
 */

export interface AccessJwk extends JsonWebKeyLike {
  readonly kid: string;
}

/** Minimal JWK-form så att typen fungerar i både Workers och Node. */
export interface JsonWebKeyLike {
  readonly kty: string;
  readonly n?: string;
  readonly e?: string;
  readonly alg?: string;
}

export interface AccessVerifierOptions {
  /** T.ex. "https://<team>.cloudflareaccess.com". */
  readonly issuer: string;
  /** Access-applikationens AUD-tagg. */
  readonly audience: string;
  /** Inbjudna e-postadresser. */
  readonly allowedEmails: readonly string[];
  /** Hämtar teamets JWKS (`<issuer>/cdn-cgi/access/certs`). */
  readonly fetchKeys: () => Promise<readonly AccessJwk[]>;
  readonly now: () => number;
}

export type AccessResult =
  | { readonly ok: true; readonly email: string }
  | { readonly ok: false; readonly reason: "malformed" | "signature" | "issuer" | "audience" | "expired" | "email" };

type CryptoKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

const LEEWAY_SECONDS = 30;

function decodeJson(part: string): unknown {
  const base64 = part.replaceAll("-", "+").replaceAll("_", "/");
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function decodeBytes(part: string): Uint8Array {
  return Uint8Array.from(atob(part.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
}

interface Parsed {
  readonly header: { alg?: unknown; kid?: unknown };
  readonly claims: { iss?: unknown; aud?: unknown; exp?: unknown; nbf?: unknown; email?: unknown };
  readonly signed: Uint8Array;
  readonly signature: Uint8Array;
}

function parse(token: string | null): Parsed | null {
  const parts = token?.split(".");
  if (parts?.length !== 3) return null;
  const [h, c, s] = parts as [string, string, string];
  try {
    return {
      header: decodeJson(h) as Parsed["header"],
      claims: decodeJson(c) as Parsed["claims"],
      signed: new TextEncoder().encode(`${h}.${c}`),
      signature: decodeBytes(s),
    };
  } catch {
    return null;
  }
}

export function createAccessVerifier(options: AccessVerifierOptions): (token: string | null) => Promise<AccessResult> {
  const allowed = new Set(options.allowedEmails.map((e) => e.toLowerCase()));
  let keys = new Map<string, Promise<CryptoKey>>();
  let loaded = false;

  async function loadKeys(): Promise<void> {
    const jwks = await options.fetchKeys();
    keys = new Map(
      jwks.map((jwk) => [
        jwk.kid,
        crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]),
      ]),
    );
    loaded = true;
  }

  async function keyFor(kid: string): Promise<CryptoKey | undefined> {
    // Okänt kid kan betyda att Access har roterat nycklar: hämta en gång till.
    if (!loaded || !keys.has(kid)) await loadKeys();
    return keys.get(kid);
  }

  return async (token) => {
    const parsed = parse(token);
    if (parsed?.header.alg !== "RS256" || typeof parsed.header.kid !== "string") {
      return { ok: false, reason: "malformed" };
    }
    const key = await keyFor(parsed.header.kid);
    const valid =
      key !== undefined && (await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, parsed.signature, parsed.signed));
    if (!valid) return { ok: false, reason: "signature" };

    const { iss, aud, exp, nbf, email } = parsed.claims;
    if (iss !== options.issuer) return { ok: false, reason: "issuer" };
    const audiences: unknown[] = Array.isArray(aud) ? aud : [aud];
    if (!audiences.includes(options.audience)) return { ok: false, reason: "audience" };
    const now = options.now() / 1000;
    if (typeof exp !== "number" || exp + LEEWAY_SECONDS < now) return { ok: false, reason: "expired" };
    if (typeof nbf === "number" && nbf - LEEWAY_SECONDS > now) return { ok: false, reason: "expired" };
    if (typeof email !== "string" || !allowed.has(email.toLowerCase())) return { ok: false, reason: "email" };
    return { ok: true, email: email.toLowerCase() };
  };
}
