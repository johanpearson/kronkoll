import { describe, expect, it } from "vitest";
import { checkCsrf } from "./csrf.ts";

const ORIGIN = "https://kronkoll.pages.dev";
const req = (method: string, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/api/x`, { method, headers });

describe("CSRF-skydd (KK-29-B)", () => {
  it.each(["GET", "HEAD", "OPTIONS"])("släpper igenom %s utan krav", (method) => {
    expect(checkCsrf(req(method), ORIGIN)).toBe(true);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])("godkänner %s med rätt Origin och header", (method) => {
    expect(checkCsrf(req(method, { origin: ORIGIN, "x-kronkoll": "1" }), ORIGIN)).toBe(true);
  });

  it("avvisar ändrande anrop utan X-Kronkoll", () => {
    expect(checkCsrf(req("POST", { origin: ORIGIN }), ORIGIN)).toBe(false);
  });

  it("avvisar fel värde i X-Kronkoll", () => {
    expect(checkCsrf(req("POST", { origin: ORIGIN, "x-kronkoll": "true" }), ORIGIN)).toBe(false);
  });

  it("avvisar främmande eller saknad Origin", () => {
    expect(checkCsrf(req("DELETE", { origin: "https://ond.example", "x-kronkoll": "1" }), ORIGIN)).toBe(false);
    expect(checkCsrf(req("DELETE", { "x-kronkoll": "1" }), ORIGIN)).toBe(false);
  });
});
