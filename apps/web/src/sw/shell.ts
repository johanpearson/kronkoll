// Service workerns logik (KK-25-A): appens skal (index.html och filerna i /assets/) cachas så att
// appen startar utan nät och går att installera. API-svar och Access-sidor rörs inte här.
// Egen liten service worker utan beroenden i stället för vite-plugin-pwa (ägarens val 2026-11-04).

export const SHELL_CACHE = "kronkoll-skal-v1";
const SHELL_URL = "/";

export interface SwEnv {
  readonly caches: CacheStorage;
  readonly fetch: (request: Request | string) => Promise<Response>;
}

type Route = "navigate" | "asset" | null;

/** Vad service workern gör med ett anrop. null betyder att webbläsaren hanterar det som vanligt. */
export function route(request: Pick<Request, "method" | "mode" | "url">, origin: string): Route {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== origin) return null;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/cdn-cgi/")) return null;
  if (request.mode === "navigate") return "navigate";
  return url.pathname.startsWith("/assets/") ? "asset" : null;
}

/** Filerna i /assets/ som index.html pekar på. De har hash i namnet och ändras aldrig. */
export function assetUrls(html: string): string[] {
  const urls = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/gu)].flatMap((match) => match[1] ?? []);
  return [...new Set(urls)];
}

// En omdirigering är Access-inloggningen och ska aldrig sparas som appens skal.
const cacheable = (response: Response): boolean => response.ok && !response.redirected;

/** Vid installation: sparar skalet och dess filer. Kommer inget skal (offline, Access) sparas inget. */
export async function precacheShell(env: SwEnv): Promise<void> {
  const response = await env.fetch(SHELL_URL);
  if (!cacheable(response)) return;
  const cache = await env.caches.open(SHELL_CACHE);
  await cache.addAll(assetUrls(await response.clone().text()));
  await cache.put(SHELL_URL, response);
}

/** Tar bort skal från äldre versioner av service workern. */
export async function removeOldShells(env: SwEnv): Promise<void> {
  const names = await env.caches.keys();
  await Promise.all(
    names.filter((name) => name.startsWith("kronkoll-skal-") && name !== SHELL_CACHE).map((name) => env.caches.delete(name)),
  );
}

/** Sidladdning: nätet först, så att en ny version och Access alltid gäller. Utan nät visas det sparade skalet. */
export async function navigate(request: Request, env: SwEnv): Promise<Response> {
  try {
    const response = await env.fetch(request);
    if (cacheable(response)) await (await env.caches.open(SHELL_CACHE)).put(SHELL_URL, response.clone());
    return response;
  } catch (error) {
    const shell = await (await env.caches.open(SHELL_CACHE)).match(SHELL_URL);
    if (shell) return shell;
    throw error;
  }
}

/** Filer i /assets/: från cachen om de finns där, annars från nätet och sparas. */
export async function asset(request: Request, env: SwEnv): Promise<Response> {
  const cache = await env.caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await env.fetch(request);
  if (cacheable(response)) await cache.put(request, response.clone());
  return response;
}
