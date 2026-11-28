// Kategorier (KK-18-A, #32, #34): lista, lägga till, byta namn, arkivera och slå ihop.
//   GET   /api/categories              alla, även arkiverade, så att äldre transaktioner har ett namn
//   POST  /api/categories              { parent_id, name } ny huvud- eller underkategori
//   PATCH /api/categories/{id}         { name } eller { archived: true }
//   POST  /api/categories/{id}/merge   { into_id } flyttar allt och arkiverar den gamla
//   POST  /api/categories/{id}/move    { before_id } flyttar före en annan bland syskonen, eller sist med null (#251)
//   POST  /api/categories/reset        { preview: true } hur mycket en rensning berör (KK-48-A)
//                                      { confirm: true, restore_template? } rensar alla kategorier (KK-48-B)
// Reglerna (två nivåer, unika namn, samma typ vid sammanslagning) finns i domänen. Ett brott mot dem ger
// 400 med domänens förklaring på svenska, som appen kan visa. Den innehåller aldrig bankdata.
import { categoryRepository, type CategoryRow } from "@kronkoll/adapter-d1";
import { CATEGORY_TEMPLATE, TEMPLATE_RULES, addCategory, archiveCategory, mergeCategories, moveCategory, renameCategory, type Category } from "@kronkoll/domain";
import type { SyncDeps } from "./sync.ts";

const MAX_NAME_LENGTH = 40;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

const invalid = () => json({ error: "invalid_request" }, 400);
const toItem = (c: CategoryRow) => ({ id: c.id, parent_id: c.parentId, name: c.name, kind: c.kind, archived: c.archived, position: c.position ?? null });

/** Kör en ändring. En RangeError från domänen blir 400 med förklaringen, annat fel 503. */
async function attempt(change: () => Promise<Response>): Promise<Response> {
  try {
    return await change();
  } catch (error) {
    return error instanceof RangeError ? json({ error: "rejected", message: error.message }, 400) : json({ error: "unavailable" }, 503);
  }
}

async function body(request: Request): Promise<Record<string, unknown> | null> {
  const parsed: unknown = await request.json().catch(() => null);
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
}

/** Ett namn att spara, eller null om det inte är text eller är för långt. Tomt avgör domänen. */
const nameOf = (value: unknown) => (typeof value === "string" && value.trim().length <= MAX_NAME_LENGTH && !/\p{Cc}/u.test(value) ? value : null);

/** Kategorierna som skiljer sig mellan före och efter. */
function changedRows(before: readonly Category[], after: readonly Category[]): Category[] {
  const old = new Map(before.map((c) => [c.id, c]));
  return after.filter((c) => {
    const o = old.get(c.id);
    return o !== undefined && (o.name !== c.name || o.archived !== c.archived || o.parentId !== c.parentId || o.position !== c.position);
  });
}

export async function listCategories(env: { DB: D1Database }): Promise<Response> {
  try {
    return json({ items: (await categoryRepository(env.DB).list()).map(toItem) }, 200);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}

export async function createCategory(request: Request, env: { DB: D1Database }, sync: SyncDeps): Promise<Response> {
  const input = await body(request);
  const name = nameOf(input?.name);
  const parentId = input?.parent_id ?? null;
  if (name === null || (parentId !== null && typeof parentId !== "string")) return invalid();
  return attempt(async () => {
    const repo = categoryRepository(env.DB);
    const { category } = addCategory(await repo.list(), { parentId, name, newId: sync.newId });
    await repo.insert(category);
    return json(toItem(category), 201);
  });
}

export async function patchCategory(request: Request, env: { DB: D1Database }, id: string): Promise<Response> {
  const input = await body(request);
  const name = input && "name" in input ? nameOf(input.name) : undefined;
  const archive = input?.archived === true;
  // Exakt en ändring per anrop: ett nytt namn eller arkivering. Att återställa en arkiverad finns inte än.
  if (name === null || (name === undefined) === !archive) return invalid();
  return attempt(async () => {
    const repo = categoryRepository(env.DB);
    const before = await repo.list();
    if (!before.some((c) => c.id === id)) return json({ error: "not_found" }, 404);
    const after = name === undefined ? archiveCategory(before, id) : renameCategory(before, id, name);
    await repo.save(changedRows(before, after));
    const item = after.find((c) => c.id === id);
    return json(item ? toItem(item) : null, 200);
  });
}

export async function mergeCategory(request: Request, env: { DB: D1Database }, fromId: string): Promise<Response> {
  const intoId = (await body(request))?.into_id;
  if (typeof intoId !== "string") return invalid();
  return attempt(async () => {
    const repo = categoryRepository(env.DB);
    const before = await repo.list();
    if (!before.some((c) => c.id === fromId)) return json({ error: "not_found" }, 404);
    // Domänen kontrollerar reglerna och räknar fram kategorierna. Transaktioner och regler flyttas i
    // databasen i en batch, så att inget behöver läsas in.
    const { categories } = mergeCategories({ categories: before, fromId, intoId, transactions: [], rules: [] });
    const moved = await repo.merge(fromId, intoId, changedRows(before, categories));
    return json({ from_id: fromId, into_id: intoId, moved_transactions: moved }, 200);
  });
}

/**
 * POST /api/categories/{id}/move (#251): flyttar kategorin före `before_id` bland sina syskon, eller sist med
 * `before_id: null`. Syskonen numreras om, och svaret har dem vars plats ändrades. Reglerna (samma nivå och typ,
 * ingen arkiverad) finns i domänen och ger 400 med förklaringen.
 */
export async function moveCategoryTo(request: Request, env: { DB: D1Database }, id: string): Promise<Response> {
  const input = await body(request);
  const beforeId = input?.before_id;
  if (input === null || !("before_id" in input) || (beforeId !== null && typeof beforeId !== "string")) return invalid();
  return attempt(async () => {
    const repo = categoryRepository(env.DB);
    const before = await repo.list();
    if (!before.some((c) => c.id === id)) return json({ error: "not_found" }, 404);
    const changed = changedRows(before, moveCategory(before, id, beforeId));
    await repo.save(changed);
    return json({ items: changed.map(toItem) }, 200);
  });
}

/**
 * POST /api/categories/reset (KK-48): börja om med kategorierna. `{ preview: true }` säger hur mycket som berörs och
 * ändrar inget. `{ confirm: true }` rensar alla kategorier, kategoriserande regler, uppdelningar och budgetrader, och
 * transaktionerna blir okategoriserade men raderas aldrig. Med `restore_template: true` sätts den svenska mallen
 * tillbaka, annars blir listan tom.
 */
export async function resetCategories(request: Request, env: { DB: D1Database }): Promise<Response> {
  const input = await body(request);
  if (input === null) return invalid();
  const { preview, confirm, restore_template: restore } = input;
  const valid = (v: unknown) => v === undefined || typeof v === "boolean";
  if (!valid(preview) || !valid(confirm) || !valid(restore) || (preview === true) === (confirm === true)) return invalid();
  return attempt(async () => {
    const repo = categoryRepository(env.DB);
    if (preview === true) {
      const s = await repo.resetSummary();
      return json({ categories: s.categories, rules: s.rules, transactions: s.transactions, splits: s.splits, budget_lines: s.budgetLines }, 200);
    }
    await repo.reset(restore === true ? { categories: CATEGORY_TEMPLATE, rules: TEMPLATE_RULES } : undefined);
    return json({ reset: true, restored_template: restore === true }, 200);
  });
}
