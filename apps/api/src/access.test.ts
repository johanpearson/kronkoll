import { beforeAll, describe, expect, it, vi } from "vitest";
import { cachedVerifier, guard, readAccessConfig, type AccessConfig, type GuardDeps } from "./access.ts";
import {
  AUD,
  INVITED,
  ISSUER,
  ORIGIN,
  captureLogs,
  configuredEnv,
  createTestKey,
  jwksFetch,
  signToken,
  type TestKey,
} from "./test-support.ts";

let key: TestKey;
beforeAll(async () => {
  key = await createTestKey();
});

describe("inställningar för åtkomstkontrollen", () => {
  it("läser alla fyra inställningarna", () => {
    expect(readAccessConfig(configuredEnv())).toEqual({
      issuer: ISSUER,
      audience: AUD,
      allowedEmails: [INVITED],
      appOrigin: ORIGIN,
    });
  });

  it("tolkar e-postlistan: kommatecken, mellanslag, versaler och tomma poster", () => {
    const config = readAccessConfig(configuredEnv({ ACCESS_ALLOWED_EMAILS: " Johan@Example.se, ,partner@example.se," }));
    expect(config?.allowedEmails).toEqual(["johan@example.se", "partner@example.se"]);
  });

  it.each([
    ["Access-teamets adress saknas", { ACCESS_TEAM_DOMAIN: undefined }],
    ["appens adress saknas", { APP_ORIGIN: undefined }],
    ["AUD-taggen saknas", { ACCESS_AUD: "  " }],
    ["e-postlistan saknas", { ACCESS_ALLOWED_EMAILS: undefined }],
    ["e-postlistan saknar adresser", { ACCESS_ALLOWED_EMAILS: " , " }],
    ["teamets adress är http", { ACCESS_TEAM_DOMAIN: "http://kronkoll-test.cloudflareaccess.com" }],
    ["teamets adress slutar med snedstreck", { ACCESS_TEAM_DOMAIN: `${ISSUER}/` }],
    ["appens adress har en sökväg", { APP_ORIGIN: `${ORIGIN}/app` }],
  ])("ger null när %s", (_, overrides) => {
    expect(readAccessConfig(configuredEnv(overrides))).toBeNull();
  });
});

describe("cachad verifierare", () => {
  const config = (): AccessConfig => ({ issuer: ISSUER, audience: AUD, allowedEmails: [INVITED], appOrigin: ORIGIN });

  it("hämtar nycklarna från teamets JWKS-adress och återanvänder dem", async () => {
    const { urls, fetchImpl } = jwksFetch(key);
    const verify = cachedVerifier(config(), fetchImpl);
    expect(await verify(await signToken(key))).toEqual({ ok: true, email: INVITED });
    expect(await cachedVerifier(config(), fetchImpl)(await signToken(key))).toMatchObject({ ok: true });
    expect(urls).toEqual([`${ISSUER}/cdn-cgi/access/certs`]);
  });

  it("skapar en ny verifierare när inställningarna ändras", async () => {
    const { fetchImpl } = jwksFetch(key);
    const first = cachedVerifier(config(), fetchImpl);
    const second = cachedVerifier({ ...config(), audience: "annan-aud" }, fetchImpl);
    expect(second).not.toBe(first);
    expect(await second(await signToken(key))).toEqual({ ok: false, reason: "audience" });
  });

  it("kastar fel när JWKS inte går att hämta", async () => {
    const verify = cachedVerifier({ ...config(), audience: "ny" }, () =>
      Promise.resolve(new Response("nere", { status: 500 })),
    );
    await expect(verify(await signToken(key, { aud: ["ny"] }))).rejects.toThrow("jwks_500");
  });

  it("använder global fetch som standard", async () => {
    const { urls, fetchImpl } = jwksFetch(key);
    vi.stubGlobal("fetch", fetchImpl);
    try {
      const verify = cachedVerifier({ ...config(), audience: "standard" });
      expect(await verify(await signToken(key, { aud: ["standard"] }))).toMatchObject({ ok: true });
      expect(urls).toEqual([`${ISSUER}/cdn-cgi/access/certs`]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("tål ett JWKS-svar utan nycklar", async () => {
    const verify = cachedVerifier({ ...config(), audience: "tom" }, () => Promise.resolve(Response.json({})));
    expect(await verify(await signToken(key, { aud: ["tom"] }))).toEqual({ ok: false, reason: "signature" });
  });
});

describe("guard (KK-2-B, KK-29-B)", () => {
  function deps(verify: GuardDeps["verifierFor"]) {
    const { lines, logger } = captureLogs();
    return { lines, deps: { verifierFor: verify, logger } satisfies GuardDeps };
  }
  const realVerifier = () => cachedVerifier({ issuer: ISSUER, audience: AUD, allowedEmails: [INVITED], appOrigin: ORIGIN }, jwksFetch(key).fetchImpl);

  async function request(init: RequestInit & { token?: string | null } = {}) {
    const { token = await signToken(key), ...rest } = init;
    const headers = new Headers(rest.headers);
    if (token !== null) headers.set("cf-access-jwt-assertion", token);
    return new Request(`${ORIGIN}/api/health`, { ...rest, headers });
  }

  it("nekar allt med 503 när inställningar saknas", async () => {
    const { lines, deps: d } = deps(realVerifier);
    const res = await guard(await request(), configuredEnv({ ACCESS_AUD: undefined }), d);
    expect(res?.status).toBe(503);
    expect(await res?.json()).toEqual({ error: "not_configured" });
    expect(lines).toEqual([{ level: "error", event: "access.not_configured", fields: {} }]);
  });

  it("nekar med 503 när Access-nycklarna inte går att hämta", async () => {
    const { lines, deps: d } = deps(() => () => Promise.reject(new Error("nätverk")));
    const res = await guard(await request(), configuredEnv(), d);
    expect(res?.status).toBe(503);
    expect(await res?.json()).toEqual({ error: "auth_unavailable" });
    expect(lines.map((l) => l.event)).toEqual(["access.keys_unavailable"]);
  });

  it("släpper igenom en GET med giltig token", async () => {
    const { lines, deps: d } = deps(realVerifier);
    expect(await guard(await request(), configuredEnv(), d)).toBeNull();
    expect(lines).toEqual([]);
  });

  it("nekar med 401 och loggar bara skälet, aldrig token eller e-post (KK-13-A)", async () => {
    const { lines, deps: d } = deps(realVerifier);
    const token = await signToken(key, { email: "okand@example.se" });
    const res = await guard(await request({ token }), configuredEnv(), d);
    expect(res?.status).toBe(401);
    expect(await res?.json()).toEqual({ error: "unauthorized" });
    expect(lines).toEqual([{ level: "warn", event: "access.denied", fields: { kind: "email" } }]);
    expect(JSON.stringify(lines)).not.toContain("okand@example.se");
    expect(JSON.stringify(lines)).not.toContain(token);
  });

  it.each([
    ["utan X-Kronkoll-headern", { origin: ORIGIN }],
    ["från en främmande origin", { origin: "https://ond.example", "x-kronkoll": "1" }],
    ["utan origin", { "x-kronkoll": "1" }],
  ])("nekar en POST %s med 403", async (_, headers) => {
    const { lines, deps: d } = deps(realVerifier);
    const res = await guard(await request({ method: "POST", headers }), configuredEnv(), d);
    expect(res?.status).toBe(403);
    expect(await res?.json()).toEqual({ error: "forbidden" });
    expect(lines.map((l) => l.event)).toEqual(["access.csrf_rejected"]);
  });

  it("släpper igenom en POST med giltig token, egen origin och X-Kronkoll", async () => {
    const { deps: d } = deps(realVerifier);
    const req = await request({ method: "POST", headers: { origin: ORIGIN, "x-kronkoll": "1" } });
    expect(await guard(req, configuredEnv(), d)).toBeNull();
  });
});
