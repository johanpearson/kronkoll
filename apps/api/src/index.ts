// API-workern. Nås bara via service binding från Pages Function (D-origin, workers_dev = false).
// Validering av Access-token i själva workern (KK-2-B) läggs till i #12.

export interface Env {
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

export async function handle(request: Request, env: Env): Promise<Response> {
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

export default {
  fetch: (request, env) => handle(request, env),
} satisfies ExportedHandler<Env>;
