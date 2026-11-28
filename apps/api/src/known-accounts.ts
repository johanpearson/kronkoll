// Kända konton (KK-54): GET /api/known-accounts, PUT och DELETE /api/known-accounts/{id} och POST
// /api/known-accounts/preview. Ett konto har ett namn, matchningstexter (Innehåller) och en standardkategori.
// Sparas ett konto kopplas hela historiken om. Namn och texter är användarens och renderas alltid som text (KK-30).
// Kontonummer lagras bara om användaren själv skriver in dem (KK-54-E).
import { categoryRepository, knownAccountRepository, type KnownAccountRecord } from "@kronkoll/adapter-d1";
import { knownAccountHits, linkKnownAccounts, validateKnownAccount, type KnownAccount } from "@kronkoll/domain";

const MAX_PATTERNS = 10;
const MAX_PATTERN_LENGTH = 60;
const MAX_NAME_LENGTH = 60;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

const view = (a: KnownAccountRecord) => ({ id: a.id, name: a.name, match_patterns: a.patterns, category_id: a.categoryId });

const readBody = async (request: Request): Promise<Record<string, unknown> | null> => {
  const body: unknown = await request.json().catch(() => null);
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
};

/** Texterna ur begäran, eller null om de inte är en lista med högst tio texter på högst 60 tecken. */
function readPatterns(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_PATTERNS) return null;
  const patterns = value.map((p) => (typeof p === "string" ? p.trim() : null));
  return patterns.every((p): p is string => p !== null && p.length <= MAX_PATTERN_LENGTH) ? patterns.filter((p) => p !== "") : null;
}

export async function listKnownAccounts(env: { DB: D1Database }): Promise<Response> {
  try {
    return json({ known_accounts: (await knownAccountRepository(env.DB).list()).map(view) }, 200);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}

/** Kontot ur begäran, kontrollerat och normaliserat, eller null om formen är fel. */
async function readAccount(request: Request, id: string): Promise<KnownAccount | null> {
  const body = await readBody(request);
  const patterns = body && readPatterns(body["match_patterns"]);
  const name = body?.["name"];
  const categoryId = body?.["category_id"];
  if (!patterns || typeof name !== "string" || name.trim().length > MAX_NAME_LENGTH || typeof categoryId !== "string" || categoryId === "") return null;
  try {
    return validateKnownAccount({ id, name, patterns, categoryId });
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

/** Kopplar om hela historiken efter att kontona ändrats, så att nya texter gäller bakåt. Returnerar antalet ändringar. */
async function relink(db: D1Database, accounts: readonly KnownAccountRecord[]): Promise<number> {
  const repo = knownAccountRepository(db);
  const changes = linkKnownAccounts(await repo.candidates(null), accounts);
  await repo.apply(changes, accounts);
  return changes.length;
}

/** PUT: lägger till kontot med det id appen valt, eller ändrar det. 201 för ett nytt konto, 200 för ett ändrat (KK-54-A). */
export async function putKnownAccount(request: Request, env: { DB: D1Database }, id: string): Promise<Response> {
  const account = await readAccount(request, id);
  if (!account) return json({ error: "invalid_request" }, 400);
  try {
    if (!(await categoryRepository(env.DB).list()).some((c) => c.id === account.categoryId)) return json({ error: "invalid_request" }, 400);
    const repo = knownAccountRepository(env.DB);
    const created = await repo.save(account);
    const linked = await relink(env.DB, await repo.list());
    return json({ ...view(account), linked }, created ? 201 : 200);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}

/**
 * DELETE: tar bort kontot. Automatiska kopplingar släpps först, med sina kategorier, så att reglerna kan sätta nya.
 * Manuella kopplingar blir okopplade när kontot försvinner (ON DELETE SET NULL).
 */
export async function deleteKnownAccount(env: { DB: D1Database }, id: string): Promise<Response> {
  try {
    const repo = knownAccountRepository(env.DB);
    const remaining = (await repo.list()).filter((a) => a.id !== id);
    await relink(env.DB, remaining);
    return (await repo.remove(id)) ? new Response(null, { status: 204 }) : json({ error: "not_found" }, 404);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}

/**
 * POST /api/known-accounts/preview: hur många transaktioner texterna träffar innan kontot sparas (KK-54-A). Med `id`
 * räknas ett befintligt konto om med de nya texterna. Sparar inget.
 */
export async function previewKnownAccount(request: Request, env: { DB: D1Database }): Promise<Response> {
  const body = await readBody(request);
  const patterns = body && readPatterns(body["match_patterns"]);
  const id = body?.["id"] === undefined ? "preview" : body["id"];
  if (!patterns || typeof id !== "string" || id === "" || id.length > 64) return json({ error: "invalid_request" }, 400);
  try {
    if (patterns.length === 0) return json({ count: 0 }, 200);
    const repo = knownAccountRepository(env.DB);
    const draft = validateKnownAccount({ id, name: "-", patterns, categoryId: null });
    const others = (await repo.list()).filter((a) => a.id !== id);
    return json({ count: knownAccountHits(await repo.candidates(null), [...others, draft], id) }, 200);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}
