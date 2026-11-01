// API-workern. Nås bara via service binding från Pages Function (D-origin, workers_dev = false),
// men litar ändå inte på det: varje anrop kräver giltig Access-token (KK-2-B) och ändrande
// anrop dessutom CSRF-skydd (KK-29-B).
import { createLogger } from "@kronkoll/logging";
import { cachedVerifier, guard, type AccessEnv, type GuardDeps } from "./access.ts";

export interface Env extends AccessEnv {
  DB: D1Database;
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

/** Svarar om databasen går att nå. Felet loggas inte och skickas inte vidare (KK-13). */
async function databaseReachable(db: D1Database): Promise<boolean> {
  try {
    await db.prepare("SELECT 1").first();
    return true;
  } catch {
    return false;
  }
}

async function route(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (pathname === "/api/health") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ error: "method_not_allowed" }, 405, { allow: "GET, HEAD" });
    }
    return (await databaseReachable(env.DB))
      ? json({ status: "ok", db: "ok" }, 200)
      : json({ status: "degraded", db: "unavailable" }, 503);
  }

  return json({ error: "not_found" }, 404);
}

export async function handle(request: Request, env: Env, deps: GuardDeps): Promise<Response> {
  return (await guard(request, env, deps)) ?? route(request, env);
}

const defaultDeps: GuardDeps = {
  verifierFor: (config) => cachedVerifier(config),
  logger: createLogger((line) => {
    console.log(JSON.stringify(line));
  }),
};

export default {
  fetch: (request, env) => handle(request, env, defaultDeps),
} satisfies ExportedHandler<Env>;
