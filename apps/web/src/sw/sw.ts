// Startpunkten för service workern. Vite bygger den till /sw.js utan hash. Logiken och testerna finns
// i shell.ts. Typerna för service workers finns inte i DOM-biblioteket, så de få som behövs står här.
import { asset, data, navigate, precacheShell, pruneData, removeOldShells, route, type SwEnv } from "./shell.ts";

interface ExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}
interface FetchEvent extends Event {
  readonly request: Request;
  respondWith(response: Promise<Response>): void;
}
interface WorkerScope {
  readonly location: { readonly origin: string };
  readonly clients: { claim(): Promise<void> };
  skipWaiting(): Promise<void>;
  addEventListener(type: "install" | "activate", listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: "fetch", listener: (event: FetchEvent) => void): void;
}

const sw = self as unknown as WorkerScope;
const env: SwEnv = { caches, fetch: (request) => fetch(request), now: () => Date.now() };

sw.addEventListener("install", (event) => {
  event.waitUntil(precacheShell(env).then(() => sw.skipWaiting()));
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(Promise.all([removeOldShells(env), pruneData(env)]).then(() => sw.clients.claim()));
});

sw.addEventListener("fetch", (event) => {
  const kind = route(event.request, sw.location.origin);
  if (kind === "navigate") event.respondWith(navigate(event.request, env));
  else if (kind === "asset") event.respondWith(asset(event.request, env));
  else if (kind === "data") event.respondWith(data(event.request, env));
});
