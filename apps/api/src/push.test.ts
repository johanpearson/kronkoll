import type { D1Database } from "@cloudflare/workers-types";
import { migratedDb } from "@kronkoll/adapter-d1/test-support";
import { fixedClock } from "@kronkoll/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cachedVerifier, type GuardDeps } from "./access.ts";
import { handle, type Env, type RouteContext } from "./index.ts";
import { AUD, INVITED, ISSUER, ORIGIN, captureLogs, configuredEnv, createTestKey, jwksFetch, signToken, type TestKey } from "./test-support.ts";

let db: D1Database;
let dispose: () => Promise<void>;
let key: TestKey;
let guardDeps: GuardDeps;
// En webbläsares nycklar till formen (0x04 + 64 byte och 16 byte). Inget krypteras i de här testerna.
const keys = { p256dh: `B${"A".repeat(86)}`, auth: "A".repeat(22) };

beforeAll(async () => {
  ({ db, dispose } = await migratedDb());
  key = await createTestKey("push-key");
  const { fetchImpl } = jwksFetch(key);
  guardDeps = {
    verifierFor: () => cachedVerifier({ issuer: ISSUER, audience: AUD, allowedEmails: [INVITED], appOrigin: ORIGIN }, fetchImpl),
    logger: captureLogs().logger,
  };
});
afterAll(async () => {
  await dispose();
});
beforeEach(async () => {
  await db.prepare(`DELETE FROM push_subscriptions`).run();
});

/** Påhittade VAPID-värden: formen räcker, inget skickas i de här testerna. */
const VAPID = { VAPID_PUBLIC_KEY: "BPublicKeyForTests", VAPID_PRIVATE_KEY: "private-key-for-tests" };
const ENDPOINT = "https://web.push.apple.com/exempel-enhet";

async function call(method: string, path: string, body?: unknown, env: Partial<Env> = VAPID) {
  let n = 0;
  const context: RouteContext = {
    waitUntil: () => undefined,
    sync: { logger: captureLogs().logger, clock: fixedClock("2026-11-05T10:00:00.000Z"), newId: () => `push-${String(++n)}`, providerFor: () => null },
    connectorFor: () => null,
  };
  const headers = new Headers({ "cf-access-jwt-assertion": await signToken(key), "content-type": "application/json" });
  if (method !== "GET") {
    headers.set("origin", ORIGIN);
    headers.set("x-kronkoll", "1");
  }
  const init = { method, headers, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) };
  return handle(new Request(`${ORIGIN}${path}`, init), configuredEnv({ DB: db, ...env }), guardDeps, context);
}

const rows = () => db.prepare(`SELECT id, endpoint, topics FROM push_subscriptions ORDER BY id`).all().then((r) => r.results);

describe("Web Push-inställningar (KK-27)", () => {
  it("ger den publika nyckeln och notistyperna när Web Push är konfigurerat", async () => {
    const res = await call("GET", "/api/push");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: true, public_key: "BPublicKeyForTests", topics: ["consent", "budget_over", "sync_failed"] });
  });

  it.each([{}, { VAPID_PUBLIC_KEY: "BPublicKeyForTests" }, { VAPID_PRIVATE_KEY: "x" }])("utan båda nycklarna är Web Push avstängt (%j)", async (env) => {
    expect(await (await call("GET", "/api/push", undefined, env)).json()).toEqual({ configured: false, public_key: null, topics: ["consent", "budget_over", "sync_failed"] });
    expect((await call("POST", "/api/push/subscriptions", { endpoint: ENDPOINT, keys, topics: [] }, env)).status).toBe(503);
  });
});

describe("prenumerera (POST /api/push/subscriptions)", () => {
  it("sparar enhetens prenumeration med valda typer", async () => {
    const res = await call("POST", "/api/push/subscriptions", { endpoint: ENDPOINT, keys, topics: ["sync_failed", "consent"] });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "push-1", topics: ["consent", "sync_failed"] });
    expect(await rows()).toEqual([{ id: "push-1", endpoint: ENDPOINT, topics: '["consent","sync_failed"]' }]);
  });

  it("samma enhet igen ändrar typerna i stället för att lägga till en rad", async () => {
    await call("POST", "/api/push/subscriptions", { endpoint: ENDPOINT, keys, topics: ["consent"] });
    const res = await call("POST", "/api/push/subscriptions", { endpoint: ENDPOINT, keys, topics: ["budget_over"] });
    expect(await res.json()).toEqual({ id: "push-1", topics: ["budget_over"] });
    expect(await rows()).toEqual([{ id: "push-1", endpoint: ENDPOINT, topics: '["budget_over"]' }]);
  });

  it.each([
    ["adress som inte är en push-tjänst", { endpoint: "https://evil.example/x" }],
    ["http-adress", { endpoint: "http://web.push.apple.com/x" }],
    ["trasiga nycklar", { keys: { p256dh: "abc", auth: "def" } }],
    ["okänd notistyp", { topics: ["sms"] }],
    ["typer saknas", { topics: undefined }],
  ])("avvisar %s", async (_, change) => {
    const res = await call("POST", "/api/push/subscriptions", { endpoint: ENDPOINT, keys, topics: ["consent"], ...change });
    expect(res.status).toBe(400);
    expect(await rows()).toEqual([]);
  });

  it.each(["inte json", "[]", "null"])("avvisar kroppen %s", async (body) => {
    expect((await call("POST", "/api/push/subscriptions", body)).status).toBe(400);
  });
});

describe("sluta prenumerera (DELETE /api/push/subscriptions)", () => {
  it("tar bort enhetens prenumeration och säger 404 andra gången", async () => {
    await call("POST", "/api/push/subscriptions", { endpoint: ENDPOINT, keys, topics: ["consent"] });
    expect((await call("DELETE", "/api/push/subscriptions", { endpoint: ENDPOINT })).status).toBe(204);
    expect(await rows()).toEqual([]);
    expect((await call("DELETE", "/api/push/subscriptions", { endpoint: ENDPOINT })).status).toBe(404);
  });

  it.each([{}, { endpoint: 1 }, { endpoint: `https://x/${"a".repeat(1024)}` }])("avvisar %j", async (body) => {
    expect((await call("DELETE", "/api/push/subscriptions", body)).status).toBe(400);
  });
});

describe("fel metod och databasfel", () => {
  it.each([
    ["POST", "/api/push", "GET"],
    ["GET", "/api/push/subscriptions", "POST, DELETE"],
  ])("%s %s ger 405", async (method, path, allow) => {
    const res = await call(method, path);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe(allow);
  });

  it("ger 503 om databasen inte svarar", async () => {
    const broken = { prepare: () => { throw new Error("db"); } } as unknown as D1Database;
    expect((await call("POST", "/api/push/subscriptions", { endpoint: ENDPOINT, keys, topics: [] }, { ...VAPID, DB: broken })).status).toBe(503);
    expect((await call("DELETE", "/api/push/subscriptions", { endpoint: ENDPOINT }, { ...VAPID, DB: broken })).status).toBe(503);
  });
});
