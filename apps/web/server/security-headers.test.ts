import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONTENT_SECURITY_POLICY, SECURITY_HEADERS, withApiSecurityHeaders } from "./security-headers.ts";

describe("säkerhetsheaders (KK-30-B)", () => {
  it("CSP kräver self för allt och förbjuder inramning", () => {
    expect(CONTENT_SECURITY_POLICY).toContain("default-src 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("connect-src 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    expect(CONTENT_SECURITY_POLICY).not.toContain("unsafe-inline");
    expect(CONTENT_SECURITY_POLICY).not.toContain("unsafe-eval");
  });

  it("public/_headers har exakt samma headers som API-svaren", () => {
    const file = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
    const lines = file.split("\n").map((line) => line.trim());
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(lines).toContain(`${name}: ${value}`);
    }
  });

  it("lägger på alla headers och no-store, och ersätter workerns cache-header", async () => {
    const upstream = new Response(JSON.stringify({ status: "ok" }), {
      status: 201,
      headers: { "content-type": "application/json", "cache-control": "public, max-age=600" },
    });
    const res = withApiSecurityHeaders(upstream);

    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(res.headers.get(name)).toBe(value);
    }
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
