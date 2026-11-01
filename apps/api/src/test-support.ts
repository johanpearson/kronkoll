// Testhjälp: ett nyckelpar som skapas när testerna körs, och påhittade Access-tokens.
// Inga riktiga nycklar eller adresser (KK-13-B).
import type { AccessJwk } from "@kronkoll/adapter-access";
import type { LogLine, Logger } from "@kronkoll/logging";
import { createLogger } from "@kronkoll/logging";
import type { Env } from "./index.ts";

export const ISSUER = "https://kronkoll-test.cloudflareaccess.com";
export const AUD = "aud-tag-test";
export const ORIGIN = "https://kronkoll-25e.pages.dev";
export const INVITED = "johan@example.se";

type PrivateKey = Awaited<ReturnType<typeof crypto.subtle.generateKey>> extends infer P
  ? P extends { privateKey: infer K }
    ? K
    : never
  : never;

export interface TestKey {
  readonly privateKey: PrivateKey;
  readonly jwk: AccessJwk;
}

export async function createTestKey(kid = "test-key"): Promise<TestKey> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as { privateKey: PrivateKey; publicKey: PrivateKey };
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as AccessJwk;
  return { privateKey: pair.privateKey, jwk: { ...jwk, kid } };
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

const encodeJson = (value: object) => base64url(new TextEncoder().encode(JSON.stringify(value)));

export async function signToken(key: TestKey, claims: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const head = encodeJson({ alg: "RS256", typ: "JWT", kid: key.jwk.kid });
  const body = encodeJson({ iss: ISSUER, aud: [AUD], email: INVITED, iat: now - 10, exp: now + 600, ...claims });
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key.privateKey,
    new TextEncoder().encode(`${head}.${body}`),
  );
  return `${head}.${body}.${base64url(new Uint8Array(signature))}`;
}

/** Svarar som Access-teamets JWKS-adress och räknar anropen. */
export function jwksFetch(key: TestKey) {
  const urls: string[] = [];
  const fetchImpl = (url: string) => {
    urls.push(url);
    return Promise.resolve(Response.json({ keys: [key.jwk] }));
  };
  return { urls, fetchImpl };
}

export function fakeDb(reachable = true) {
  const queries: string[] = [];
  const db = {
    prepare: (sql: string) => {
      queries.push(sql);
      return { first: () => (reachable ? Promise.resolve({ 1: 1 }) : Promise.reject(new Error("D1 nere"))) };
    },
  };
  return { db: db as unknown as D1Database, queries };
}

export function configuredEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: fakeDb().db,
    ACCESS_TEAM_DOMAIN: ISSUER,
    APP_ORIGIN: ORIGIN,
    ACCESS_AUD: AUD,
    ACCESS_ALLOWED_EMAILS: INVITED,
    ...overrides,
  };
}

export function captureLogs(): { lines: LogLine[]; logger: Logger } {
  const lines: LogLine[] = [];
  return { lines, logger: createLogger((line) => lines.push(line)) };
}
