import { describe, expect, it } from "vitest";
import worker, { handle, type Env } from "./index.ts";

const BASE = "https://kronkoll-25e.pages.dev";

/** Minimal låtsas-D1: bara det health-kontrollen använder. */
function fakeEnv(reachable = true): { env: Env; queries: string[] } {
  const queries: string[] = [];
  const db = {
    prepare: (sql: string) => {
      queries.push(sql);
      return {
        first: () => (reachable ? Promise.resolve({ 1: 1 }) : Promise.reject(new Error("D1 nere"))),
      };
    },
  };
  return { env: { DB: db } as unknown as Env, queries };
}

describe("API-workern", () => {
  it("svarar ok på /api/health när databasen går att nå", async () => {
    const { env, queries } = fakeEnv();
    const res = await handle(new Request(`${BASE}/api/health`), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await res.json()).toEqual({ status: "ok", db: "ok" });
    expect(queries).toEqual(["SELECT 1"]);
  });

  it("svarar 503 utan feldetaljer när databasen inte går att nå", async () => {
    const res = await handle(new Request(`${BASE}/api/health`), fakeEnv(false).env);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "degraded", db: "unavailable" });
  });

  it("tillåter HEAD på /api/health", async () => {
    const res = await handle(new Request(`${BASE}/api/health`, { method: "HEAD" }), fakeEnv().env);
    expect(res.status).toBe(200);
  });

  it("nekar andra metoder än GET och HEAD på /api/health utan att fråga databasen", async () => {
    const { env, queries } = fakeEnv();
    const res = await handle(new Request(`${BASE}/api/health`, { method: "POST" }), env);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
    expect(await res.json()).toEqual({ error: "method_not_allowed" });
    expect(queries).toEqual([]);
  });

  it("svarar 404 med JSON på okända vägar", async () => {
    const res = await handle(new Request(`${BASE}/api/finns-inte`), fakeEnv().env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("exporterar en fetch-handler som Cloudflare kan anropa", async () => {
    const res = await worker.fetch(new Request(`${BASE}/api/health`), fakeEnv().env);
    expect(res.status).toBe(200);
  });
});
