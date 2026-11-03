// Regler (#34, KK-18-B, KK-18-C): se, lägga till, ändra och ta bort kategoriseringsregler.
//   GET    /api/rules        alla regler med antal träffar och om kategorin är arkiverad
//   POST   /api/rules        { pattern, category_id } ny regel: "allt som börjar med …"
//   PATCH  /api/rules/{id}   { pattern?, category_id? }
//   DELETE /api/rules/{id}
// En ny eller ändrad regel gäller direkt för nya transaktioner (synken kategoriserar med den). Svaret
// säger hur många tidigare den skulle ändra; appen frågar och använder POST /api/rules/{id}/apply.
// Manuellt valda rörs aldrig.
import { categoryRepository, ruleRepository, transactionRepository } from "@kronkoll/adapter-d1";
import { normalizeCounterparty, ruleHits, ruleReach, type CategoryRule } from "@kronkoll/domain";
import type { SyncDeps } from "./sync.ts";

const MAX_PATTERN_LENGTH = 60;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

const invalid = () => json({ error: "invalid_request" }, 400);
const toItem = (r: CategoryRule) => ({ id: r.id, match: r.match, pattern: r.pattern, category_id: r.categoryId, source: r.source });

async function body(request: Request): Promise<Record<string, unknown> | null> {
  const parsed: unknown = await request.json().catch(() => null);
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
}

/** Mönstret normaliserat som en motpart, t.ex. "ikea " → "IKEA". Null om det inte går att använda. */
function patternOf(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_PATTERN_LENGTH || /\p{Cc}/u.test(value)) return null;
  const pattern = normalizeCounterparty(value);
  return pattern === "" ? null : pattern;
}

/** Sant om kategorin finns och går att välja. */
async function usable(db: D1Database, categoryId: unknown): Promise<boolean> {
  return typeof categoryId === "string" && (await categoryRepository(db).list()).some((c) => c.id === categoryId && !c.archived);
}

/** Regeln och vad den skulle ändra bakåt, som svar på en ny eller ändrad regel. */
async function withReach(db: D1Database, rule: CategoryRule, status: number): Promise<Response> {
  const rules = await ruleRepository(db).list();
  const reach = ruleReach(await transactionRepository(db).categorizable(), rules, rule.id);
  return json({ rule: toItem(rule), retroactive_candidates: reach.changes.length, protected_manual: reach.protectedManual }, status);
}

export async function listRules(env: { DB: D1Database }): Promise<Response> {
  try {
    const [rules, categories, transactions] = await Promise.all([
      ruleRepository(env.DB).list(),
      categoryRepository(env.DB).list(),
      transactionRepository(env.DB).categorizable(),
    ]);
    const archived = new Set(categories.filter((c) => c.archived).map((c) => c.id));
    const hits = ruleHits(transactions, rules);
    const items = [...rules]
      .sort((a, b) => a.pattern.localeCompare(b.pattern, "sv"))
      .map((r) => ({ ...toItem(r), hits: hits.get(r.id) ?? 0, category_archived: archived.has(r.categoryId) }));
    return json({ items }, 200);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}

export async function createRule(request: Request, env: { DB: D1Database }, sync: SyncDeps): Promise<Response> {
  const input = await body(request);
  const pattern = patternOf(input?.pattern);
  if (pattern === null || typeof input?.category_id !== "string") return invalid();
  const categoryId = input.category_id;
  try {
    if (!(await usable(env.DB, categoryId))) return json({ error: "unknown_category" }, 400);
    const repo = ruleRepository(env.DB);
    // Finns redan en egen regel med samma mönster byter den kategori i stället, som vid "Gör alltid så".
    const existing = (await repo.list()).find((r) => r.source === "learned" && r.match === "counterparty_prefix" && r.pattern === pattern);
    const rule: CategoryRule = existing
      ? { ...existing, categoryId }
      : { id: sync.newId(), match: "counterparty_prefix", pattern, categoryId, source: "learned" };
    await repo.save(rule);
    return await withReach(env.DB, rule, existing ? 200 : 201);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}

export async function patchRule(request: Request, env: { DB: D1Database }, id: string): Promise<Response> {
  const input = await body(request);
  if (input === null || (!("pattern" in input) && !("category_id" in input))) return invalid();
  const pattern = "pattern" in input ? patternOf(input.pattern) : undefined;
  if (pattern === null || ("category_id" in input && typeof input.category_id !== "string")) return invalid();
  try {
    const repo = ruleRepository(env.DB);
    const current = (await repo.list()).find((r) => r.id === id);
    if (!current) return json({ error: "not_found" }, 404);
    const categoryId = typeof input.category_id === "string" ? input.category_id : current.categoryId;
    if (categoryId !== current.categoryId && !(await usable(env.DB, categoryId))) return json({ error: "unknown_category" }, 400);
    const rule = { ...current, pattern: pattern ?? current.pattern, categoryId };
    await repo.update(rule);
    return await withReach(env.DB, rule, 200);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}

export async function deleteRule(env: { DB: D1Database }, id: string): Promise<Response> {
  try {
    return (await ruleRepository(env.DB).remove(id)) ? new Response(null, { status: 204 }) : json({ error: "not_found" }, 404);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}
