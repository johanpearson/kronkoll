import { afterEach, describe, expect, it, vi } from "vitest";
import { field, getJson, postJson } from "./api.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("postJson", () => {
  it("skickar JSON med CSRF-header och ger status och svar", async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify({ ok: 1 }), { status: 201 })));
    vi.stubGlobal("fetch", fetchMock);
    expect(await postJson("/api/x", { a: 1 })).toEqual({ status: 201, body: { ok: 1 } });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("x-kronkoll")).toBe("1");
    expect(init?.body).toBe('{"a":1}');
  });

  it("ett svar som inte är JSON ger body null", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("<html>", { status: 502 })));
    expect(await postJson("/api/x", {})).toEqual({ status: 502, body: null });
  });

  it("ett anrop som aldrig svarar avbryts efter tidsgränsen och ger status 0", async () => {
    let aborted = false;
    vi.stubGlobal("fetch", (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("Avbrutet", "AbortError"));
        });
      }),
    );
    expect(await postJson("/api/x", {}, 10)).toEqual({ status: 0, body: null });
    expect(aborted).toBe(true);
  });
});

describe("getJson", () => {
  it("hämtar JSON med Access-cookien och ger status och svar", async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    expect(await getJson("/api/transactions")).toEqual({ status: 200, body: { items: [] } });
    expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBe("same-origin");
  });

  it("ett nätverksfel ger status 0", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    expect(await getJson("/api/x")).toEqual({ status: 0, body: null });
  });

  it("ett anrop som aldrig svarar avbryts efter tidsgränsen", async () => {
    vi.stubGlobal("fetch", (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Avbrutet", "AbortError"));
        });
      }),
    );
    expect(await getJson("/api/x", 10)).toEqual({ status: 0, body: null });
  });
});

describe("field", () => {
  it("läser ett fält ur ett objekt och ger null annars", () => {
    expect(field({ a: 1 }, "a")).toBe(1);
    expect(field({ a: 1 }, "b")).toBeNull();
    expect(field(null, "a")).toBeNull();
    expect(field("text", "a")).toBeNull();
  });
});
