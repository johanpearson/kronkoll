// Testet ligger här och inte i functions/, eftersom varje fil där blir en route i Pages.
import { describe, expect, it } from "vitest";
import { onRequest, type Env } from "../functions/api/[[path]].ts";

function callProxy(request: Request, upstream: Response) {
  const forwarded: Request[] = [];
  const env = {
    API: {
      fetch: (req: Request) => {
        forwarded.push(req);
        return Promise.resolve(upstream);
      },
    },
  } as unknown as Env;
  const context = { request, env } as unknown as EventContext<Env, string, Record<string, unknown>>;
  return { forwarded, response: onRequest(context) };
}

describe("Pages Function /api/* (D-origin)", () => {
  it("skickar anropet oförändrat till API-workern, med Access-token", async () => {
    const request = new Request("https://kronkoll-25e.pages.dev/api/health", {
      headers: { "cf-access-jwt-assertion": "syntetisk-token" },
    });
    const { forwarded, response } = callProxy(request, new Response("{}"));
    await response;

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toBe(request);
    expect(forwarded[0]?.headers.get("cf-access-jwt-assertion")).toBe("syntetisk-token");
  });

  it("returnerar workerns svar med säkerhetsheaders och no-store", async () => {
    const upstream = new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    const res = await callProxy(new Request("https://kronkoll-25e.pages.dev/api/health"), upstream).response;

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
