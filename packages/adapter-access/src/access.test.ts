import { beforeAll, describe, expect, it, vi } from "vitest";
import { createAccessVerifier, type AccessJwk } from "./access.ts";

const ISSUER = "https://kronkoll.cloudflareaccess.com";
const AUD = "aud-tag-123";
const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const nowSec = NOW / 1000;

type KeyPair = { privateKey: CryptoKey; jwk: AccessJwk };
type CryptoKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

async function keyPair(kid: string): Promise<KeyPair> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as AccessJwk;
  return { privateKey: pair.privateKey, jwk: { ...jwk, kid } };
}

const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");

async function token(key: KeyPair, claims: Record<string, unknown>, header: Record<string, unknown> = {}) {
  const head = b64({ alg: "RS256", typ: "JWT", kid: key.jwk.kid, ...header });
  const body = b64({ iss: ISSUER, aud: [AUD], email: "johan@example.se", iat: nowSec - 10, exp: nowSec + 600, ...claims });
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${Buffer.from(sig).toString("base64url")}`;
}

let key: KeyPair;
let otherKey: KeyPair;
beforeAll(async () => {
  key = await keyPair("k1");
  otherKey = await keyPair("k2");
});

function verifier(fetchKeys = vi.fn(() => Promise.resolve([key.jwk]))) {
  return {
    fetchKeys,
    verify: createAccessVerifier({
      issuer: ISSUER,
      audience: AUD,
      allowedEmails: ["johan@example.se"],
      fetchKeys,
      now: () => NOW,
    }),
  };
}

describe("validering av Access-JWT (KK-2-B)", () => {
  it("godkänner en giltig token från en inbjuden adress", async () => {
    expect(await verifier().verify(await token(key, {}))).toEqual({ ok: true, email: "johan@example.se" });
  });

  it.each([
    ["saknad token", null],
    ["trasig token", "inte.en-jwt"],
    ["tre delar som inte är JSON", "e30.!!!.abc"],
  ])("avvisar %s", async (_, value) => {
    expect(await verifier().verify(value)).toEqual({ ok: false, reason: "malformed" });
  });

  it("avvisar fel aud", async () => {
    expect(await verifier().verify(await token(key, { aud: ["annan-app"] }))).toEqual({ ok: false, reason: "audience" });
  });

  it("avvisar fel utfärdare", async () => {
    expect(await verifier().verify(await token(key, { iss: "https://ond.example" }))).toEqual({ ok: false, reason: "issuer" });
  });

  it("avvisar utgången token", async () => {
    expect(await verifier().verify(await token(key, { exp: nowSec - 60 }))).toEqual({ ok: false, reason: "expired" });
  });

  it("avvisar token som inte gäller än", async () => {
    expect(await verifier().verify(await token(key, { nbf: nowSec + 600 }))).toEqual({ ok: false, reason: "expired" });
  });

  it("avvisar signatur från en annan nyckel", async () => {
    const forged = await token(otherKey, {}, { kid: "k1" });
    expect(await verifier().verify(forged)).toEqual({ ok: false, reason: "signature" });
  });

  it("avvisar okänd nyckel-id", async () => {
    expect(await verifier().verify(await token(otherKey, {}))).toEqual({ ok: false, reason: "signature" });
  });

  it("avvisar andra algoritmer än RS256, t.ex. alg none", async () => {
    expect(await verifier().verify(await token(key, {}, { alg: "none" }))).toEqual({ ok: false, reason: "malformed" });
  });

  it("avvisar e-post som inte finns i listan, oavsett skiftläge i listan", async () => {
    expect(await verifier().verify(await token(key, { email: "okand@example.com" }))).toEqual({ ok: false, reason: "email" });
    expect(await verifier().verify(await token(key, { email: "JOHAN@example.se" }))).toEqual({ ok: true, email: "johan@example.se" });
  });

  it("hämtar nycklarna en gång och cachar dem", async () => {
    const v = verifier();
    await v.verify(await token(key, {}));
    await v.verify(await token(key, {}));
    expect(v.fetchKeys).toHaveBeenCalledTimes(1);
  });

  it("hämtar nycklarna igen vid okänt kid (nyckelrotation)", async () => {
    const fetchKeys = vi.fn().mockResolvedValueOnce([key.jwk]).mockResolvedValue([key.jwk, otherKey.jwk]);
    const v = verifier(fetchKeys);
    await v.verify(await token(key, {}));
    expect(await v.verify(await token(otherKey, {}))).toEqual({ ok: true, email: "johan@example.se" });
    expect(fetchKeys).toHaveBeenCalledTimes(2);
  });
});
