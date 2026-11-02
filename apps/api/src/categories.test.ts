import type { D1Database } from "@cloudflare/workers-types";
import { migratedDb } from "@kronkoll/adapter-d1/test-support";
import { fixedClock } from "@kronkoll/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cachedVerifier, type GuardDeps } from "./access.ts";
import { handle, type Env, type RouteContext } from "./index.ts";
import { AUD, INVITED, ISSUER, ORIGIN, captureLogs, configuredEnv, createTestKey, jwksFetch, signToken, type TestKey } from "./test-support.ts";

let db: D1Database;
let dispose: () => Promise<void>;
let key: TestKey;
let guardDeps: GuardDeps;

beforeAll(async () => {
  ({ db, dispose } = await migratedDb());
  key = await createTestKey("categories-key");
  const { fetchImpl } = jwksFetch(key);
  guardDeps = {
    verifierFor: () => cachedVerifier({ issuer: ISSUER, audience: AUD, allowedEmails: [INVITED], appOrigin: ORIGIN }, fetchImpl),
    logger: captureLogs().logger,
  };
});
afterAll(async () => {
  await dispose();
});

async function call(method = "GET", env: Partial<Env> = {}) {
  const context: RouteContext = {
    waitUntil: () => undefined,
    sync: { logger: captureLogs().logger, clock: fixedClock("2026-11-15T10:00:00.000Z"), newId: () => "x", providerFor: () => null },
    connectorFor: () => null,
  };
  const headers = new Headers({ "cf-access-jwt-assertion": await signToken(key) });
  if (method !== "GET") {
    headers.set("origin", ORIGIN);
    headers.set("x-kronkoll", "1");
  }
  return handle(new Request(`${ORIGIN}/api/categories`, { method, headers }), configuredEnv({ DB: db, ...env }), guardDeps, context);
}

describe("GET /api/categories (KK-18-A, #32)", () => {
  it("ger kategorierna i snake_case", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const { items } = await res.json<{ items: Record<string, unknown>[] }>();
    expect(items.find((c) => c.id === "mat-livsmedel")).toEqual({ id: "mat-livsmedel", parent_id: "mat", name: "Livsmedel", kind: "expense", archived: false });
    expect(items.find((c) => c.id === "mat")).toMatchObject({ parent_id: null });
  });

  it("svarar 503 utan detaljer när databasen inte går att läsa", async () => {
    const broken = { prepare: () => { throw new Error("D1 nere"); } } as unknown as D1Database;
    const res = await call("GET", { DB: broken });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
  });

  it("andra metoder ger 405", async () => {
    const res = await call("POST");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });
});
