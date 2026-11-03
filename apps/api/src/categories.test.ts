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
let seq = 0;

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

async function call(method = "GET", path = "/api/categories", body?: unknown, env: Partial<Env> = {}) {
  const context: RouteContext = {
    waitUntil: () => undefined,
    sync: { logger: captureLogs().logger, clock: fixedClock("2026-11-15T10:00:00.000Z"), newId: () => `ny-${String(++seq)}`, providerFor: () => null },
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

const items = async () => (await (await call()).json<{ items: Record<string, unknown>[] }>()).items;
const broken = { prepare: () => { throw new Error("D1 nere"); } } as unknown as D1Database;

describe("GET /api/categories (KK-18-A, #32)", () => {
  it("ger kategorierna i snake_case", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect((await items()).find((c) => c.id === "mat-livsmedel")).toEqual({ id: "mat-livsmedel", parent_id: "mat", name: "Livsmedel", kind: "expense", archived: false });
    expect((await items()).find((c) => c.id === "mat")).toMatchObject({ parent_id: null });
  });

  it("svarar 503 utan detaljer när databasen inte går att läsa", async () => {
    const res = await call("GET", undefined, undefined, { DB: broken });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
  });

  it("andra metoder ger 405", async () => {
    const res = await call("DELETE");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, POST");
  });
});

describe("POST /api/categories (KK-18-A)", () => {
  it("lägger till en underkategori som ärver huvudkategorins typ, och en ny huvudkategori för utgifter", async () => {
    const sub = await call("POST", undefined, { parent_id: "fritid", name: " Simskola " });
    expect(sub.status).toBe(201);
    expect(await sub.json()).toEqual({ id: "ny-1", parent_id: "fritid", name: "Simskola", kind: "expense", archived: false });
    const main = await call("POST", undefined, { parent_id: null, name: "Husdjur" });
    expect(await main.json()).toMatchObject({ parent_id: null, name: "Husdjur", kind: "expense" });
    expect((await items()).some((c) => c.name === "Husdjur")).toBe(true);
  });

  it("ett namn som redan finns under samma förälder ger 400 med förklaringen", async () => {
    const res = await call("POST", undefined, { parent_id: "mat", name: "livsmedel" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "rejected", message: "Det finns redan en kategori som heter livsmedel" });
  });

  it.each([
    ["en tredje nivå", { parent_id: "mat-livsmedel", name: "Frukt" }, "rejected"],
    ["en okänd förälder", { parent_id: "finns-inte", name: "Frukt" }, "rejected"],
    ["ett tomt namn", { parent_id: null, name: "  " }, "rejected"],
    ["ett för långt namn", { parent_id: null, name: "x".repeat(41) }, "invalid_request"],
    ["en radbrytning", { parent_id: null, name: "Hus\ndjur" }, "invalid_request"],
    ["en förälder som inte är text", { parent_id: 7, name: "Frukt" }, "invalid_request"],
    ["inte JSON", "{", "invalid_request"],
  ])("%s ger 400", async (_, body, error) => {
    const res = await call("POST", undefined, body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error });
  });
});

describe("PATCH /api/categories/{id} (KK-18-A)", () => {
  it("byter namn", async () => {
    const res = await call("PATCH", "/api/categories/noje-spel", { name: "Spel & dataspel" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "noje-spel", parent_id: "noje", name: "Spel & dataspel", kind: "expense", archived: false });
  });

  it("arkiverar en huvudkategori och dess underkategorier", async () => {
    const res = await call("PATCH", "/api/categories/boende", { archived: true });
    expect(await res.json()).toMatchObject({ id: "boende", archived: true });
    const all = await items();
    expect(all.filter((c) => c.id === "boende" || c.parent_id === "boende").every((c) => c.archived === true)).toBe(true);
  });

  it.each([
    ["både namn och arkivering", { name: "X", archived: true }],
    ["ingen ändring", {}],
    ["återställa en arkiverad", { archived: false }],
    ["ett namn som inte är text", { name: 5 }],
  ])("%s ger 400", async (_, body) => {
    expect((await call("PATCH", "/api/categories/noje-spel", body)).status).toBe(400);
  });

  it("en okänd kategori ger 404, och andra metoder 405", async () => {
    expect((await call("PATCH", "/api/categories/finns-inte", { name: "X" })).status).toBe(404);
    const res = await call("DELETE", "/api/categories/noje-spel");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("PATCH");
  });

  it("svarar 503 utan detaljer när databasen inte går att skriva", async () => {
    const res = await call("PATCH", "/api/categories/noje-spel", { name: "X" }, { DB: broken });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
  });
});

describe("POST /api/categories/{id}/merge (KK-18-A)", () => {
  it("slår ihop två kategorier och arkiverar den gamla", async () => {
    const res = await call("POST", "/api/categories/noje-bar-uteliv/merge", { into_id: "mat-restaurang-cafe" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ from_id: "noje-bar-uteliv", into_id: "mat-restaurang-cafe", moved_transactions: 0 });
    expect((await items()).find((c) => c.id === "noje-bar-uteliv")).toMatchObject({ archived: true });
  });

  it("olika nivåer ger 400 med förklaringen", async () => {
    const res = await call("POST", "/api/categories/fritid-hobby/merge", { into_id: "mat" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "rejected", message: "Kategorierna måste ligga på samma nivå" });
  });

  it("utan into_id 400, okänd kategori 404, andra metoder 405", async () => {
    expect((await call("POST", "/api/categories/fritid-hobby/merge", {})).status).toBe(400);
    expect((await call("POST", "/api/categories/finns-inte/merge", { into_id: "mat" })).status).toBe(404);
    const res = await call("GET", "/api/categories/fritid-hobby/merge");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });
});
