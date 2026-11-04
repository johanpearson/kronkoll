import { describe, expect, it } from "vitest";
import { asset, assetUrls, navigate, precacheShell, removeOldShells, route, SHELL_CACHE, type SwEnv } from "./shell.ts";

const ORIGIN = "https://kronkoll.test";
const INDEX = `<script type="module" src="/assets/index-abc.js"></script><link rel="stylesheet" href="/assets/index-def.css"><link rel="icon" href="/icons/icon.svg">`;

/** Cache Storage i minnet, med samma beteende som webbläsarens för det service workern använder. */
function fakeCaches() {
  const stores = new Map<string, Map<string, Response>>();
  const key = (request: Request | string) => new URL(typeof request === "string" ? request : request.url, ORIGIN).href;
  const caches = {
    open: (name: string) => {
      const store = stores.get(name) ?? new Map<string, Response>();
      stores.set(name, store);
      return Promise.resolve({
        match: (request: Request | string) => Promise.resolve(store.get(key(request))?.clone()),
        put: (request: Request | string, response: Response) => {
          store.set(key(request), response);
          return Promise.resolve();
        },
        addAll: (urls: string[]) => {
          for (const url of urls) store.set(key(url), new Response(`innehåll i ${url}`));
          return Promise.resolve();
        },
      });
    },
    keys: () => Promise.resolve([...stores.keys()]),
    delete: (name: string) => Promise.resolve(stores.delete(name)),
  } as unknown as CacheStorage;
  return { caches, stores };
}

function environment(respond: (url: string) => Response | Error) {
  const { caches, stores } = fakeCaches();
  const calls: string[] = [];
  const env: SwEnv = {
    caches,
    fetch: (request) => {
      const url = new URL(typeof request === "string" ? request : request.url, ORIGIN).href;
      calls.push(url);
      const result = respond(url);
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
  };
  return { env, stores, calls };
}

const redirected = () => {
  const response = new Response("Access");
  Object.defineProperty(response, "redirected", { value: true });
  return response;
};

describe("route", () => {
  const request = (url: string, mode: RequestMode = "cors", method = "GET") => ({ url: `${ORIGIN}${url}`, mode, method });

  it("tar sidladdningar och filerna i /assets/", () => {
    expect(route(request("/transaktioner", "navigate"), ORIGIN)).toBe("navigate");
    expect(route(request("/assets/index-abc.js", "no-cors"), ORIGIN)).toBe("asset");
  });

  it("lämnar API:t, Access, andra metoder, andra filer och andra origin åt webbläsaren", () => {
    expect(route(request("/api/overview"), ORIGIN)).toBeNull();
    expect(route(request("/api/overview", "navigate"), ORIGIN)).toBeNull();
    expect(route(request("/cdn-cgi/access/logout", "navigate"), ORIGIN)).toBeNull();
    expect(route(request("/assets/index-abc.js", "cors", "POST"), ORIGIN)).toBeNull();
    expect(route(request("/manifest.webmanifest"), ORIGIN)).toBeNull();
    expect(route({ url: "https://annan.test/assets/x.js", mode: "cors", method: "GET" }, ORIGIN)).toBeNull();
  });
});

describe("assetUrls", () => {
  it("hittar varje fil i /assets/ en gång och hoppar över andra filer", () => {
    expect(assetUrls(`${INDEX}<script src="/assets/index-abc.js"></script>`)).toEqual(["/assets/index-abc.js", "/assets/index-def.css"]);
  });
});

describe("precacheShell", () => {
  it("sparar skalet och filerna det pekar på", async () => {
    const { env, stores } = environment(() => new Response(INDEX));
    await precacheShell(env);
    const store = stores.get(SHELL_CACHE);
    expect([...(store?.keys() ?? [])]).toEqual([`${ORIGIN}/assets/index-abc.js`, `${ORIGIN}/assets/index-def.css`, `${ORIGIN}/`]);
    expect(await store?.get(`${ORIGIN}/`)?.text()).toBe(INDEX);
  });

  it("sparar inget när svaret är ett fel eller Access-inloggningen", async () => {
    for (const response of [new Response("", { status: 500 }), redirected()]) {
      const { env, stores } = environment(() => response);
      await precacheShell(env);
      expect(stores.size).toBe(0);
    }
  });
});

describe("removeOldShells", () => {
  it("tar bort äldre skal men inte det aktuella eller andra cachar", async () => {
    const { env, stores } = environment(() => new Response());
    for (const name of ["kronkoll-skal-v0", SHELL_CACHE, "annat"]) await env.caches.open(name);
    await removeOldShells(env);
    expect([...stores.keys()]).toEqual([SHELL_CACHE, "annat"]);
  });
});

describe("navigate", () => {
  const page = new Request(`${ORIGIN}/budget`);

  it("hämtar sidan från nätet och sparar den som skal", async () => {
    const { env, stores } = environment(() => new Response("ny version"));
    expect(await (await navigate(page, env)).text()).toBe("ny version");
    expect(await stores.get(SHELL_CACHE)?.get(`${ORIGIN}/`)?.text()).toBe("ny version");
  });

  it("skickar vidare Access-inloggningen och fel utan att spara dem", async () => {
    for (const response of [redirected(), new Response("", { status: 404 })]) {
      const { env, stores } = environment(() => response);
      expect(await navigate(page, env)).toBe(response);
      expect(stores.get(SHELL_CACHE)?.size ?? 0).toBe(0);
    }
  });

  it("visar det sparade skalet utan nät", async () => {
    const { env } = environment(() => new TypeError("offline"));
    await (await env.caches.open(SHELL_CACHE)).put("/", new Response("sparat skal"));
    expect(await (await navigate(page, env)).text()).toBe("sparat skal");
  });

  it("ger nätverksfelet vidare när inget skal finns", async () => {
    const { env } = environment(() => new TypeError("offline"));
    await expect(navigate(page, env)).rejects.toThrow("offline");
  });
});

describe("asset", () => {
  const file = new Request(`${ORIGIN}/assets/index-abc.js`);

  it("tar filen från cachen utan att gå till nätet", async () => {
    const { env, calls } = environment(() => new Response("nät"));
    await (await env.caches.open(SHELL_CACHE)).put(file, new Response("cachad"));
    expect(await (await asset(file, env)).text()).toBe("cachad");
    expect(calls).toEqual([]);
  });

  it("hämtar en fil som saknas och sparar den, men inte ett fel", async () => {
    const { env, stores } = environment((url) => (url.endsWith("abc.js") ? new Response("nät") : new Response("", { status: 404 })));
    expect(await (await asset(file, env)).text()).toBe("nät");
    expect((await asset(new Request(`${ORIGIN}/assets/saknas.js`), env)).status).toBe(404);
    expect([...(stores.get(SHELL_CACHE)?.keys() ?? [])]).toEqual([`${ORIGIN}/assets/index-abc.js`]);
  });
});
