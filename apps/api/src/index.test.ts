import { describe, expect, it } from "vitest";
import worker, { handle } from "./index.ts";

const BASE = "https://kronkoll-25e.pages.dev";

describe("API-workern", () => {
  it("svarar ok på /api/health", async () => {
    const res = handle(new Request(`${BASE}/api/health`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("tillåter HEAD på /api/health", () => {
    expect(handle(new Request(`${BASE}/api/health`, { method: "HEAD" })).status).toBe(200);
  });

  it("nekar andra metoder än GET och HEAD på /api/health", async () => {
    const res = handle(new Request(`${BASE}/api/health`, { method: "POST" }));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
    expect(await res.json()).toEqual({ error: "method_not_allowed" });
  });

  it("svarar 404 med JSON på okända vägar", async () => {
    const res = handle(new Request(`${BASE}/api/finns-inte`));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("exporterar en fetch-handler som Cloudflare kan anropa", () => {
    const res = worker.fetch(new Request(`${BASE}/api/health`));
    expect(res.status).toBe(200);
  });
});
