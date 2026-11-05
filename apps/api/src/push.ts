// Web Push (KK-27, D-notify): GET /api/push ger den publika VAPID-nyckeln som webbläsaren behöver för att
// prenumerera, POST /api/push/subscriptions sparar enhetens prenumeration och valda notistyper och
// DELETE tar bort den. Adress och nycklar loggas aldrig.
import { pushRepository } from "@kronkoll/adapter-d1";
import { isPushEndpoint, isPushKeys } from "@kronkoll/adapter-webpush";
import { NOTIFICATION_TOPICS, parseTopics } from "@kronkoll/domain";
import { vapidPublicKey, type PushEnv } from "./notify.ts";
import type { SyncDeps } from "./sync.ts";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

export function getPushConfig(env: PushEnv): Response {
  const publicKey = vapidPublicKey(env);
  return json({ configured: publicKey !== null, public_key: publicKey, topics: NOTIFICATION_TOPICS }, 200);
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  const body: unknown = await request.json().catch(() => null);
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

/** POST: samma adress igen uppdaterar nycklar och typer. 201 med prenumerationens id. */
export async function subscribe(request: Request, env: PushEnv, sync: SyncDeps): Promise<Response> {
  if (vapidPublicKey(env) === null) return json({ error: "not_configured" }, 503);
  const body = await readBody(request);
  const topics = parseTopics(body?.topics);
  if (!body || !isPushEndpoint(body.endpoint) || !isPushKeys(body.keys) || topics === null) return json({ error: "invalid_request" }, 400);
  try {
    const id = await pushRepository(env.DB).save({ id: sync.newId(), endpoint: body.endpoint, p256dh: body.keys.p256dh, auth: body.keys.auth, topics });
    sync.logger.info("push.subscribed", { count: topics.length });
    return json({ id, topics }, 201);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}

/** DELETE: enheten slutar prenumerera. Den vet bara sin adress. */
export async function unsubscribe(request: Request, env: PushEnv): Promise<Response> {
  const body = await readBody(request);
  if (!body || typeof body.endpoint !== "string" || body.endpoint.length > 1024) return json({ error: "invalid_request" }, 400);
  try {
    return (await pushRepository(env.DB).removeByEndpoint(body.endpoint)) ? new Response(null, { status: 204 }) : json({ error: "not_found" }, 404);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}
