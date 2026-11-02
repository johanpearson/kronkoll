import { ProviderError } from "@kronkoll/domain";
import { describe, expect, it } from "vitest";
import { createEnableBankingConnector } from "./connector.ts";

/** Svar formade som Enable Bankings API, med påhittade värden (KK-13). */
type Route = { status?: number; body: unknown };

function fakeApi(routes: Record<string, Route>) {
  const calls: { method: string; path: string; query: string; body: unknown; auth: string | null; contentType: string | null }[] = [];
  const fetchImpl = (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    calls.push({
      method,
      path: url.pathname,
      query: url.search,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null,
      auth: headers.get("authorization"),
      contentType: headers.get("content-type"),
    });
    const route = routes[`${method} ${url.pathname}`];
    if (!route) return Promise.resolve(new Response("not found", { status: 404 }));
    return Promise.resolve(new Response(typeof route.body === "string" ? route.body : JSON.stringify(route.body), { status: route.status ?? 200 }));
  };
  const connector = createEnableBankingConnector({
    signer: { sign: () => Promise.resolve("jwt-test") },
    fetch: fetchImpl,
    now: () => Date.parse("2026-11-20T10:00:00.000Z"),
  });
  return { connector, calls };
}

const DAY = 86_400;
const aspsps = (overrides: Record<string, unknown> = {}) => ({
  aspsps: [
    { name: "Annan Bank", country: "SE", maximum_consent_validity: 10 * DAY, psu_types: ["personal"] },
    { name: "Skandia", country: "SE", maximum_consent_validity: 180 * DAY, psu_types: ["personal", "business"], ...overrides },
  ],
});
const request = { aspspName: "Skandia", country: "SE", state: "s.sig", redirectUrl: "https://kronkoll-25e.pages.dev/koppla/klar" };

describe("starta samtycke (KK-5-A, KK-8)", () => {
  it("begär bara kontoinformation, med bankens längsta giltighetstid minus en timme", async () => {
    const { connector, calls } = fakeApi({
      "GET /aspsps": { body: aspsps() },
      "POST /auth": { body: { url: "https://tilisy.enablebanking.com/welcome?x=1", authorization_id: "a1" } },
    });
    expect(await connector.startAuthorization(request)).toEqual({ url: "https://tilisy.enablebanking.com/welcome?x=1" });
    expect(calls.map((c) => `${c.method} ${c.path}${c.query}`)).toEqual(["GET /aspsps?country=SE", "POST /auth"]);
    expect(calls[1]?.body).toEqual({
      access: { valid_until: "2027-05-19T09:00:00.000Z" },
      aspsp: { name: "Skandia", country: "SE" },
      state: "s.sig",
      redirect_url: "https://kronkoll-25e.pages.dev/koppla/klar",
      psu_type: "personal",
    });
    expect(calls[1]).toMatchObject({ auth: "Bearer jwt-test", contentType: "application/json" });
  });

  it("använder 90 dagar när banken inte anger någon gräns", async () => {
    const { connector, calls } = fakeApi({
      "GET /aspsps": { body: aspsps({ maximum_consent_validity: undefined }) },
      "POST /auth": { body: { url: "https://tilisy.enablebanking.com/x" } },
    });
    await connector.startAuthorization(request);
    expect(calls[1]?.body).toMatchObject({ access: { valid_until: "2027-02-18T09:00:00.000Z" } });
  });

  it("väljer privatperson när banken stöder det, annars bankens första typ", async () => {
    const { connector, calls } = fakeApi({
      "GET /aspsps": { body: aspsps({ psu_types: ["business"] }) },
      "POST /auth": { body: { url: "https://tilisy.enablebanking.com/x" } },
    });
    await connector.startAuthorization(request);
    expect(calls[1]?.body).toMatchObject({ psu_type: "business" });
  });

  it("en bank som inte finns ger FAILED utan att något samtycke begärs", async () => {
    const { connector, calls } = fakeApi({ "GET /aspsps": { body: aspsps() } });
    await expect(connector.startAuthorization({ ...request, aspspName: "Finns Inte" })).rejects.toEqual(new ProviderError("FAILED"));
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it.each([
    ["ingen länk", {}],
    ["länk utan https", { url: "http://tilisy.enablebanking.com/x" }],
    ["länk som inte är en adress", { url: "https://" }],
  ])("ett svar med %s ger BAD_RESPONSE", async (_, body) => {
    const { connector } = fakeApi({ "GET /aspsps": { body: aspsps() }, "POST /auth": { body } });
    await expect(connector.startAuthorization(request)).rejects.toEqual(new ProviderError("BAD_RESPONSE"));
  });
});

describe("skapa session efter godkännandet (KK-5, KK-8)", () => {
  it("ger session-id och sista giltiga dag i svensk tid", async () => {
    const { connector, calls } = fakeApi({
      "POST /sessions": { body: { session_id: "3f1d2c4b-0000-4000-8000-00000000abcd", accounts: [{ uid: "a1" }], access: { valid_until: "2027-04-30T22:30:00.000Z" } } },
    });
    expect(await connector.createSession("kod-123")).toEqual({ sessionId: "3f1d2c4b-0000-4000-8000-00000000abcd", consentExpiresOn: "2027-05-01" });
    expect(calls).toEqual([expect.objectContaining({ method: "POST", path: "/sessions", body: { code: "kod-123" }, auth: "Bearer jwt-test" })]);
  });

  it("saknar banken giltighetstid blir den okänd", async () => {
    const { connector } = fakeApi({ "POST /sessions": { body: { session_id: "s1", accounts: [] } } });
    expect(await connector.createSession("k")).toEqual({ sessionId: "s1", consentExpiresOn: null });
  });

  it.each([
    ["inget session-id", { accounts: [] }],
    ["ogiltig giltighetstid", { session_id: "s1", access: { valid_until: "imorgon" } }],
    ["inte JSON", "<html>"],
  ])("%s ger BAD_RESPONSE", async (_, body) => {
    const { connector } = fakeApi({ "POST /sessions": { body } });
    await expect(connector.createSession("k")).rejects.toEqual(new ProviderError("BAD_RESPONSE"));
  });
});

describe("fel utan svarstext (KK-13)", () => {
  it.each([
    [400, "FAILED"],
    [401, "UNAUTHORIZED"],
    [429, "RATE_LIMITED"],
    [502, "UNAVAILABLE"],
  ] as const)("HTTP %i ger %s, och varken kod, state eller bankens text följer med", async (status, code) => {
    const { connector } = fakeApi({
      "GET /aspsps": { body: aspsps() },
      "POST /auth": { status, body: { message: "konto 1234 och state s.sig" } },
      "POST /sessions": { status, body: { message: "kod-123 redan använd" } },
    });
    const authError = await connector.startAuthorization(request).catch((e: unknown) => e);
    const sessionError = await connector.createSession("kod-123").catch((e: unknown) => e);
    expect(authError).toEqual(new ProviderError(code));
    expect(sessionError).toEqual(new ProviderError(code));
    for (const text of ["1234", "s.sig", "kod-123"]) expect(`${String(authError)} ${String(sessionError)}`).not.toContain(text);
  });

  it("nätverksfel ger UNAVAILABLE", async () => {
    const down = createEnableBankingConnector({ signer: { sign: () => Promise.resolve("x") }, fetch: () => Promise.reject(new Error("dns")) });
    await expect(down.createSession("k")).rejects.toEqual(new ProviderError("UNAVAILABLE"));
  });
});
