// Den riktiga workern i workerd (KK-16, V-i-access): standardexporten med sina riktiga beroenden,
// Access-kontrollen som hämtar nycklar med global fetch och en migrerad D1. Bara Access-teamets
// nyckeladress stubbas. Tokens och nycklar skapas när testerna körs (KK-13-B).
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ISSUER, ORIGIN, createTestKey, signToken, type TestKey } from "../src/test-support.ts";
import worker from "../src/index.ts";

let key: TestKey;
const jwksCalls: string[] = [];

beforeAll(async () => {
  key = await createTestKey("integration-key");
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== `${ISSUER}/cdn-cgi/access/certs`) return realFetch(input, init);
    jwksCalls.push(url);
    return Promise.resolve(Response.json({ keys: [key.jwk] }));
  });
});

let log: ReturnType<typeof captureConsole> | undefined;
function captureConsole() {
  return vi.spyOn(console, "log").mockImplementation(() => undefined);
}
const logged = () => (log?.mock.calls.flat().map(String) ?? []).join("\n");

afterEach(() => {
  log?.mockRestore();
  log = undefined;
});

async function call(path: string, init: RequestInit & { token?: string | null } = {}): Promise<Response> {
  const { token = await signToken(key), ...rest } = init;
  const headers = new Headers(rest.headers);
  if (token !== null) headers.set("cf-access-jwt-assertion", token);
  return exports.default.fetch(new Request(`${ORIGIN}${path}`, { ...rest, headers }));
}

describe("Access i Workers-miljön (KK-2-B, V-i-access)", () => {
  it.each([
    ["giltig token", 200, {}],
    ["fel aud", 401, { aud: ["annan-applikation"] }],
    ["utgången token", 401, { exp: Math.floor(Date.now() / 1000) - 3600 }],
  ])("%s ger %i", async (_, status, claims) => {
    const res = await call("/api/health", { token: await signToken(key, claims) });
    expect(res.status).toBe(status);
  });

  it("saknad token ger 401", async () => {
    expect((await call("/api/health", { token: null })).status).toBe(401);
  });

  it("hämtar Access-nycklarna från teamets adress och cachar dem i isolaten", () => {
    expect(jwksCalls.length).toBeGreaterThan(0);
    expect(new Set(jwksCalls)).toEqual(new Set([`${ISSUER}/cdn-cgi/access/certs`]));
  });

  it("loggar aldrig token eller e-postadress", async () => {
    log = captureConsole();
    const token = await signToken(key, { aud: ["annan-applikation"] });
    await call("/api/health", { token });
    const output = logged();
    expect(output).toContain("access");
    expect(output).not.toContain(token);
    expect(output).not.toContain("johan@example.se");
  });
});

describe("API mot riktig D1 (KK-16)", () => {
  it("hälsokontrollen når databasen", async () => {
    const res = await call("/api/health");
    expect(await res.json()).toEqual({ status: "ok", db: "ok" });
  });

  it("en ny kategori sparas och syns i listan", async () => {
    const created = await call("/api/categories", {
      method: "POST",
      headers: { origin: ORIGIN, "x-kronkoll": "1", "content-type": "application/json" },
      body: JSON.stringify({ name: "Integrationstest" }),
    });
    expect(created.status).toBe(201);
    const list = await call("/api/categories");
    const { items } = await list.json<{ items: { name: string }[] }>();
    expect(items.map((c) => c.name)).toContain("Integrationstest");
  });

  it("manuell synk utan bankhemligheter svarar 503", async () => {
    const res = await call("/api/sync", { method: "POST", headers: { origin: ORIGIN, "x-kronkoll": "1" } });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "not_configured" });
  });
});

describe("Cron Trigger (KK-7)", () => {
  it("den schemalagda synken körs klart och skriver ingen körning utan bankhemligheter", async () => {
    log = captureConsole();
    const ctx = createExecutionContext();
    worker.scheduled(createScheduledController({ cron: "7 4,15 * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(logged()).toContain("sync.not_configured");
    const runs = await env.DB.prepare("SELECT COUNT(*) AS n FROM sync_runs").first<{ n: number }>();
    expect(runs?.n).toBe(0);
  });
});
