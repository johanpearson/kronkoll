// API-workern. Nås bara via service binding från Pages Function (D-origin, workers_dev = false).
// Validering av Access-token i själva workern (KK-2-B) läggs till i #12.

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export function handle(request: Request): Response {
  const { pathname } = new URL(request.url);

  if (pathname === "/api/health") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ error: "method_not_allowed" }, 405, { allow: "GET, HEAD" });
    }
    return json({ status: "ok" }, 200);
  }

  return json({ error: "not_found" }, 404);
}

export default {
  fetch: (request) => handle(request),
} satisfies ExportedHandler;
