import { beforeAll, describe, expect, it } from "vitest";
import { cachedVerifier, type GuardDeps } from "./access.ts";
import worker, { handle } from "./index.ts";
import {
  AUD,
  INVITED,
  ISSUER,
  ORIGIN,
  captureLogs,
  configuredEnv,
  createTestKey,
  fakeDb,
  jwksFetch,
  signToken,
  type TestKey,
} from "./test-support.ts";

let key: TestKey;
let deps: GuardDeps;
beforeAll(async () => {
  key = await createTestKey("index-key");
  const { fetchImpl } = jwksFetch(key);
  deps = {
    verifierFor: () =>
      cachedVerifier({ issuer: ISSUER, audience: AUD, allowedEmails: [INVITED], appOrigin: ORIGIN }, fetchImpl),
    logger: captureLogs().logger,
  };
});

async function call(path: string, init: RequestInit & { token?: string | null } = {}, env = configuredEnv()) {
  const { token = await signToken(key), ...rest } = init;
  const headers = new Headers(rest.headers);
  if (token !== null) headers.set("cf-access-jwt-assertion", token);
  return handle(new Request(`${ORIGIN}${path}`, { ...rest, headers }), env, deps);
}

describe("Access-krav för hela API:t (KK-2-B, V-i-access)", () => {
  it.each([
    ["giltig token", {}, 200],
    ["fel aud", { aud: ["annan-applikation"] }, 401],
    ["utgången token", { exp: Math.floor(Date.now() / 1000) - 3600 }, 401],
  ])("%s ger %i", async (_, claims, status) => {
    const res = await call("/api/health", { token: await signToken(key, claims) });
    expect(res.status).toBe(status);
  });

  it("saknad token ger 401", async () => {
    expect((await call("/api/health", { token: null })).status).toBe(401);
  });

  it("frågar inte databasen när anropet nekas", async () => {
    const { db, queries } = fakeDb();
    const res = await call("/api/health", { token: null }, configuredEnv({ DB: db }));
    expect(res.status).toBe(401);
    expect(queries).toEqual([]);
  });

  it("en POST utan CSRF-header ger 403 (KK-29-B, V-i-csrf)", async () => {
    expect((await call("/api/health", { method: "POST", headers: { origin: ORIGIN } })).status).toBe(403);
  });
});

describe("/api/health", () => {
  it("svarar ok när databasen går att nå", async () => {
    const { db, queries } = fakeDb();
    const res = await call("/api/health", {}, configuredEnv({ DB: db }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await res.json()).toEqual({ status: "ok", db: "ok" });
    expect(queries).toEqual(["SELECT 1"]);
  });

  it("svarar 503 utan feldetaljer när databasen inte går att nå", async () => {
    const res = await call("/api/health", {}, configuredEnv({ DB: fakeDb(false).db }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "degraded", db: "unavailable" });
  });

  it("tillåter HEAD", async () => {
    expect((await call("/api/health", { method: "HEAD" })).status).toBe(200);
  });

  it("svarar 405 på andra metoder, efter godkänd CSRF-kontroll", async () => {
    const res = await call("/api/health", { method: "POST", headers: { origin: ORIGIN, "x-kronkoll": "1" } });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
  });

  it("svarar 404 med JSON på okända vägar", async () => {
    const res = await call("/api/finns-inte");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});

describe("exporterad fetch-handler", () => {
  it("kräver Access-token även med alla inställningar på plats", async () => {
    const res = await worker.fetch(new Request(`${ORIGIN}/api/health`), configuredEnv());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("nekar allt när inställningarna saknas, utan att anropa nätet", async () => {
    const res = await worker.fetch(new Request(`${ORIGIN}/api/health`), { DB: fakeDb().db });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "not_configured" });
  });
});
