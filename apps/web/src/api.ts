// Anrop till API:t på samma origin. Ändrande anrop skickar X-Kronkoll, som CSRF-skyddet kräver
// (KK-29-B). Access-cookien följer med automatiskt.

export type ApiResult = { readonly status: number; readonly body: unknown };

/** Hur länge ett anrop får ta innan det avbryts, så att vyn aldrig väntar för evigt. */
export const TIMEOUT_MS = 20_000;

/**
 * POST med JSON. Ett nätverksfel eller ett anrop som tar längre än tidsgränsen ger status 0,
 * så att anroparen alltid får ett svar att visa.
 */
export function postJson(path: string, body: unknown, timeoutMs = TIMEOUT_MS): Promise<ApiResult> {
  return sendJson("POST", path, body, timeoutMs);
}

/** PATCH med JSON, likadant som postJson. */
export function patchJson(path: string, body: unknown, timeoutMs = TIMEOUT_MS): Promise<ApiResult> {
  return sendJson("PATCH", path, body, timeoutMs);
}

/** PUT med JSON, likadant som postJson. */
export function putJson(path: string, body: unknown, timeoutMs = TIMEOUT_MS): Promise<ApiResult> {
  return sendJson("PUT", path, body, timeoutMs);
}

/** DELETE utan innehåll, likadant som postJson. Ett 204-svar ger body null. */
export function deleteJson(path: string, timeoutMs = TIMEOUT_MS): Promise<ApiResult> {
  return sendJson("DELETE", path, undefined, timeoutMs);
}

async function sendJson(method: "POST" | "PATCH" | "PUT" | "DELETE", path: string, body: unknown, timeoutMs: number): Promise<ApiResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-kronkoll": "1" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  } catch {
    return { status: 0, body: null };
  } finally {
    clearTimeout(timer);
  }
}

/** GET som ger JSON, med samma tidsgräns och felhantering som postJson. */
export async function getJson(path: string, timeoutMs = TIMEOUT_MS): Promise<ApiResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(path, { credentials: "same-origin", signal: controller.signal });
    return { status: response.status, body: await response.json().catch(() => null) };
  } catch {
    return { status: 0, body: null };
  } finally {
    clearTimeout(timer);
  }
}

/** Ett textfält ur ett JSON-svar, eller null. Svaret behandlas som okänd indata. */
export function field(body: unknown, name: string): unknown {
  return typeof body === "object" && body !== null && name in body ? (body as Record<string, unknown>)[name] : null;
}
