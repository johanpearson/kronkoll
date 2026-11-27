// Egna kontonamn (KK-37): GET /api/accounts och PATCH /api/accounts/{id}. Namnet är användarens
// text och renderas som text i appen (KK-37-C). Synken rör det aldrig (KK-37-B).
import { accountNameRepository } from "@kronkoll/adapter-d1";
import type { AccountRole } from "@kronkoll/domain";
import { recomputeTransfers } from "./transfers.ts";

const ROLES: readonly string[] = ["spending", "buffer", "excluded"] satisfies AccountRole[];

export const MAX_NICKNAME_LENGTH = 40;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

export async function listAccounts(env: { DB: D1Database }): Promise<Response> {
  try {
    const rows = await accountNameRepository(env.DB).list();
    return json(
      { items: rows.map((a) => ({ id: a.id, name: a.nickname ?? a.bankName, nickname: a.nickname, bank_name: a.bankName, bank: a.bank, type: a.type, role: a.role })) },
      200,
    );
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}

interface AccountChange {
  /** Det nya namnet: trimmat, null för tomt. Utelämnat betyder att namnet inte ändras. */
  readonly nickname?: string | null;
  /** Kontots roll (KK-53). Utelämnat betyder att rollen inte ändras. */
  readonly role?: AccountRole;
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
  const hasRole = "role" in body;
  if (!hasNickname && !hasRole) return undefined;
  if (hasRole && (typeof body.role !== "string" || !ROLES.includes(body.role))) return undefined;
  const nickname = hasNickname ? parseNickname(body.nickname) : undefined;
  if (hasNickname && nickname === undefined) return undefined;
  return { ...(hasNickname ? { nickname: nickname ?? null } : {}), ...(hasRole ? { role: body.role as AccountRole } : {}) };
}

export async function patchAccount(request: Request, env: { DB: D1Database }, id: string): Promise<Response> {
  const change = await readChange(request);
  if (change === undefined) return json({ error: "invalid_request" }, 400);
  try {
    const names = accountNameRepository(env.DB);
    if (change.nickname !== undefined && !(await names.set(id, change.nickname))) return json({ error: "not_found" }, 404);
    if (change.role !== undefined) {
      if (!(await names.list()).some((a) => a.id === id)) return json({ error: "not_found" }, 404);
      await names.setRole(id, change.role);
      // Vad som är en intern överföring beror på kontonas roller, så hela historiken räknas om (KK-53-A).
      await recomputeTransfers(env.DB);
    }
    const account = (await names.list()).find((a) => a.id === id);
    if (account === undefined) return json({ error: "not_found" }, 404);
    return json({ id, name: account.nickname ?? account.bankName, nickname: account.nickname, role: account.role }, 200);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}
