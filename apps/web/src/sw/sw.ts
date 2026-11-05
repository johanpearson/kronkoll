// Startpunkten för service workern. Vite bygger den till /sw.js utan hash. Logiken och testerna finns
// i shell.ts. Typerna för service workers finns inte i DOM-biblioteket, så de få som behövs står här.
import { clickTarget, noticeFrom } from "./push.ts";
import { asset, data, navigate, precacheShell, pruneData, removeOldShells, route, type SwEnv } from "./shell.ts";

interface ExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}
interface FetchEvent extends Event {
  readonly request: Request;
  respondWith(response: Promise<Response>): void;
}
interface PushEvent extends ExtendableEvent {
  readonly data: { text(): string } | null;
}
interface NotificationEvent extends ExtendableEvent {
  readonly notification: { readonly data: unknown; close(): void };
}
interface WindowClient {
  readonly url: string;
  focus(): Promise<unknown>;
  navigate(url: string): Promise<unknown>;
}
interface WorkerScope {
  readonly location: { readonly origin: string };
  readonly clients: { claim(): Promise<void>; matchAll(options: { type: "window" }): Promise<readonly WindowClient[]>; openWindow(url: string): Promise<unknown> };
  readonly registration: { showNotification(title: string, options: object): Promise<void> };
  skipWaiting(): Promise<void>;
  addEventListener(type: "install" | "activate", listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: "fetch", listener: (event: FetchEvent) => void): void;
  addEventListener(type: "push", listener: (event: PushEvent) => void): void;
  addEventListener(type: "notificationclick", listener: (event: NotificationEvent) => void): void;
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

// Web Push (KK-27): visa notisen, och öppna eller fokusera appen när den trycks.
sw.addEventListener("push", (event) => {
  const shown = noticeFrom(event.data?.text() ?? null);
  event.waitUntil(sw.registration.showNotification(shown.title, shown.options));
});

sw.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = clickTarget(event.notification.data, sw.location.origin);
  event.waitUntil(
    sw.clients.matchAll({ type: "window" }).then(async (windows) => {
      const open = windows.find((w) => w.url.startsWith(sw.location.origin));
      if (!open) return sw.clients.openWindow(url);
      await open.focus();
      return open.navigate(url);
    }),
  );
});
