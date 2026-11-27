// Egna kontonamn (KK-37): GET /api/accounts och PATCH /api/accounts/{id}. Namnet är användarens
// text och renderas som text i appen (KK-37-C). Synken rör det aldrig (KK-37-B).
import { accountNameRepository } from "@kronkoll/adapter-d1";
import { recomputeTransfers } from "./transfers.ts";

export const MAX_NICKNAME_LENGTH = 40;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

export async function listAccounts(env: { DB: D1Database }): Promise<Response> {
  try {
    const rows = await accountNameRepository(env.DB).list();
    return json(
      { items: rows.map((a) => ({ id: a.id, name: a.nickname ?? a.bankName, nickname: a.nickname, bank_name: a.bankName, bank: a.bank, type: a.type, counted: a.counted, saving: a.saving })) },
      200,
    );
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}

interface AccountChange {
  /** Det nya namnet: trimmat, null för tomt. Utelämnat betyder att namnet inte ändras. */
  readonly nickname?: string | null;
  /** Om kontot räknas med (KK-41-A). Utelämnat betyder att valet inte ändras. */
  readonly counted?: boolean;
  /** Om kontot är ett sparkonto (KK-52). Utelämnat betyder att valet inte ändras. */
  readonly saving?: boolean;
}

/** Namnet ur en begäran: trimmat, null för tomt. Undefined om det är fel form, för långt eller har styrtecken. */
function parseNickname(nickname: unknown): string | null | undefined {
  if (nickname === null) return null;
  if (typeof nickname !== "string") return undefined;
  const trimmed = nickname.trim();
  // Längden räknas i UTF-16-enheter: å, ä och ö är en enhet, en emoji två.
  if (trimmed.length > MAX_NICKNAME_LENGTH || /\p{Cc}/u.test(trimmed)) return undefined;
  return trimmed === "" ? null : trimmed;
}

/** Ändringen ur begäran, eller undefined om formen är fel eller inget av fälten finns. */
async function readChange(request: Request): Promise<AccountChange | undefined> {
  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== "object" || body === null) return undefined;
  const hasNickname = "nickname" in body;
  const hasCounted = "counted" in body;
  const hasSaving = "saving" in body;
  if (!hasNickname && !hasCounted && !hasSaving) return undefined;
  if (hasSaving && typeof body.saving !== "boolean") return undefined;
  const nickname = hasNickname ? parseNickname(body.nickname) : undefined;
  if (hasNickname && nickname === undefined) return undefined;
  if (hasCounted && typeof body.counted !== "boolean") return undefined;
  return { ...(hasNickname ? { nickname: nickname ?? null } : {}), ...(hasCounted ? { counted: body.counted as boolean } : {}), ...(hasSaving ? { saving: body.saving as boolean } : {}) };
}

export async function patchAccount(request: Request, env: { DB: D1Database }, id: string): Promise<Response> {
  const change = await readChange(request);
  if (change === undefined) return json({ error: "invalid_request" }, 400);
  try {
    const names = accountNameRepository(env.DB);
    if (change.nickname !== undefined && !(await names.set(id, change.nickname))) return json({ error: "not_found" }, 404);
    if (change.counted !== undefined) {
      if (!(await names.setCounted(id, change.counted))) return json({ error: "not_found" }, 404);
    }
    if (change.saving !== undefined && !(await names.setSaving(id, change.saving))) return json({ error: "not_found" }, 404);
    // Vad som är en intern överföring beror på vilka konton som räknas med och vilka som är sparkonton (KK-41-D, KK-52).
    if (change.counted !== undefined || change.saving !== undefined) await recomputeTransfers(env.DB);
    const account = (await names.list()).find((a) => a.id === id);
    if (account === undefined) return json({ error: "not_found" }, 404);
    return json({ id, name: account.nickname ?? account.bankName, nickname: account.nickname, counted: account.counted, saving: account.saving }, 200);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}
