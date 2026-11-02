// Egna kontonamn (KK-37): GET /api/accounts och PATCH /api/accounts/{id}. Namnet är användarens
// text och renderas som text i appen (KK-37-C). Synken rör det aldrig (KK-37-B).
import { accountNameRepository } from "@kronkoll/adapter-d1";

export const MAX_NICKNAME_LENGTH = 40;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

export async function listAccounts(env: { DB: D1Database }): Promise<Response> {
  try {
    const rows = await accountNameRepository(env.DB).list();
    return json(
      { items: rows.map((a) => ({ id: a.id, name: a.nickname ?? a.bankName, nickname: a.nickname, bank_name: a.bankName, bank: a.bank, type: a.type })) },
      200,
    );
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}

/** Det nya namnet: trimmat, null för tomt. Undefined om formen är fel, namnet för långt eller har styrtecken. */
async function readNickname(request: Request): Promise<string | null | undefined> {
  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== "object" || body === null || !("nickname" in body)) return undefined;
  const { nickname } = body;
  if (nickname === null) return null;
  if (typeof nickname !== "string") return undefined;
  const trimmed = nickname.trim();
  // Längden räknas i UTF-16-enheter: å, ä och ö är en enhet, en emoji två.
  if (trimmed.length > MAX_NICKNAME_LENGTH || /\p{Cc}/u.test(trimmed)) return undefined;
  return trimmed === "" ? null : trimmed;
}

export async function patchAccount(request: Request, env: { DB: D1Database }, id: string): Promise<Response> {
  const nickname = await readNickname(request);
  if (nickname === undefined) return json({ error: "invalid_request" }, 400);
  try {
    const names = accountNameRepository(env.DB);
    if (!(await names.set(id, nickname))) return json({ error: "not_found" }, 404);
    const account = (await names.list()).find((a) => a.id === id);
    return json({ id, name: nickname ?? account?.bankName ?? null, nickname }, 200);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}
