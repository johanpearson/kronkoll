// Regler (#34, KK-18-B, KK-18-C): se, lägga till, ändra och ta bort kategoriseringsregler.
//   GET    /api/rules        alla regler med antal träffar och om kategorin är arkiverad
//   POST   /api/rules        { pattern, category_id, match? } ny regel: "allt som börjar med …" (match "prefix",
//                            standard) eller "allt som innehåller …" (match "contains", KK-47)
//                            { pattern, action: "exclude", match?, preview? } Räkna inte (KK-39-C), gäller hela historiken
//   PATCH  /api/rules/{id}   { pattern?, category_id?, match? } (en Räkna inte-regel har bara mönster och slag)
//   DELETE /api/rules/{id}
//   GET    /api/rules/{id}/matches  förhandsvisning: transaktionerna regeln gäller och vad som händer
//   POST   /api/rules/apply-all     alla regler över hela historiken ({ preview: true } räknar bara)
//   POST   /api/rules/reset         { preview: true } hur många regler som tas bort, { confirm: true } tar bort alla (KK-51)
//   PUT    /api/rules/order         { order: [id, …] } de egna reglernas ordning, den som vinner först (KK-58-C)
// POST och PATCH tar också `override_manual: true`, som skriver över manuellt valda där regeln vinner (KK-58-B), och
// POST `preview: true`, som bara räknar vad regeln skulle göra.
// En ny eller ändrad regel tillämpas direkt på tidigare transaktioner där den vinner, utan fråga (KK-58-A),
// och synken kategoriserar nya med den. Svaret säger hur många som ändrades. Manuellt valda rörs aldrig.
// POST /api/rules/{id}/apply finns kvar för äldre appar och ändrar då inget mer.
import { categoryRepository, ruleRepository, transactionRepository } from "@kronkoll/adapter-d1";
import { applyAllRules, excludeRuleHits, normalizeCounterparty, ruleHits, ruleMatches, ruleReach, type CategoryRule, type ExcludeRule, type RuleReach } from "@kronkoll/domain";
import type { SyncDeps } from "./sync.ts";
import { recomputeTransfers } from "./transfers.ts";

const MAX_PATTERN_LENGTH = 60;

/** Slag av träff i begäran: börjar med en motpart, eller innehåller en text var som helst (KK-47). */
type Kind = "prefix" | "contains";
const MATCH = { prefix: "counterparty_prefix", contains: "description_contains" } as const satisfies Record<Kind, CategoryRule["match"]>;
const kindOf = (match: CategoryRule["match"]): Kind => (match === "description_contains" ? "contains" : "prefix");

/** `match` i begäran: undefined när det saknas, null när värdet är fel. */
function kindFrom(input: Record<string, unknown>): Kind | null | undefined {
  if (!("match" in input)) return undefined;
  return input.match === "prefix" || input.match === "contains" ? input.match : null;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

const invalid = () => json({ error: "invalid_request" }, 400);
const toItem = (r: CategoryRule) => ({ id: r.id, match: r.match, pattern: r.pattern, category_id: r.categoryId, source: r.source, action: "categorize" });
const excludeItem = (r: ExcludeRule) => ({ id: r.id, match: r.match, pattern: r.pattern, category_id: null, source: "learned", action: "exclude" });

/** Hur många transaktioner en Räkna inte-regel träffar, egna val inräknade (KK-39-C). */
async function excludeMatches(db: D1Database, rule: ExcludeRule): Promise<number> {
  return excludeRuleHits(await transactionRepository(db).forTransfers(), [rule]).get(rule.id) ?? 0;
}

async function body(request: Request): Promise<Record<string, unknown> | null> {
  const parsed: unknown = await request.json().catch(() => null);
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
}

/**
 * Mönstret som det sparas: som en motpart för "börjar med" (t.ex. "ikea " → "IKEA"), och för "innehåller" bara
 * trimmat med versaler, så att "amazon" och "AMAZON" blir samma regel (KK-47). Null om det inte går att använda.
 */
function patternOf(value: unknown, kind: Kind = "prefix"): string | null {
  if (typeof value !== "string" || value.length > MAX_PATTERN_LENGTH || /\p{Cc}/u.test(value)) return null;
  const pattern = kind === "contains" ? value.trim().replace(/\s+/gu, " ").toLocaleUpperCase("sv-SE") : normalizeCounterparty(value);
  return pattern === "" ? null : pattern;
}

/** Sant om kategorin finns och går att välja. */
async function usable(db: D1Database, categoryId: unknown): Promise<boolean> {
  return typeof categoryId === "string" && (await categoryRepository(db).list()).some((c) => c.id === categoryId && !c.archived);
}

/**
 * Tillämpar en ny eller ändrad regel direkt på tidigare transaktioner där den vinner (KK-58-A), och svarar med
 * hur många som ändrades. Manuellt valda rörs inte. `retroactive_candidates` är alltid 0 och finns kvar för
 * en äldre app i telefonens cache, som annars frågar om något som redan är gjort.
 */
async function applied(db: D1Database, rule: CategoryRule, status: number, overrideManual: boolean): Promise<Response> {
  const store = transactionRepository(db);
  const reach = ruleReach(await store.categorizable(), await ruleRepository(db).list(), rule.id, { overrideManual });
  await store.setCategories(reach.changes, { overrideManual });
  return json({ rule: toItem(rule), applied: reach.changes.length, retroactive_candidates: 0, protected_manual: reach.protectedManual }, status);
}

/** `override_manual` och `preview` i begäran: falskt när de saknas, null när värdet inte är sant eller falskt. */
function flags(input: Record<string, unknown>): { overrideManual: boolean; preview: boolean } | null {
  const { override_manual: overrideManual = false, preview = false } = input;
  return typeof overrideManual === "boolean" && typeof preview === "boolean" ? { overrideManual, preview } : null;
}

/**
 * Vad en regel som ännu inte är sparad skulle göra (KK-58-B): som när den sparas, där en ny regel står först.
 * `overridden_manual` är de manuellt valda som valet Skriv över skulle ändra.
 */
async function preview(db: D1Database, rule: CategoryRule, overrideManual: boolean): Promise<Response> {
  const rules = (await ruleRepository(db).list()).filter((r) => r.id !== rule.id);
  const places = rules.flatMap((r) => (r.position === undefined ? [] : [r.position]));
  const candidate = { ...rule, position: rule.position ?? Math.min(1, ...places) - 1 };
  const transactions = await transactionRepository(db).categorizable();
  const reach: RuleReach = ruleReach(transactions, [...rules, candidate], rule.id, { overrideManual });
  const overridden = overrideManual ? ruleReach(transactions, [...rules, candidate], rule.id).protectedManual : 0;
  return json({ applied: reach.changes.length, protected_manual: reach.protectedManual, overridden_manual: overridden }, 200);
}

export async function listRules(env: { DB: D1Database }): Promise<Response> {
  try {
    const repo = ruleRepository(env.DB);
    const [rules, excludeRules, categories, transactions, forTransfers] = await Promise.all([
      repo.list(),
      repo.excludeRules(),
      categoryRepository(env.DB).list(),
      transactionRepository(env.DB).categorizable(),
      transactionRepository(env.DB).forTransfers(),
    ]);
    const archived = new Set(categories.filter((c) => c.archived).map((c) => c.id));
    const hits = ruleHits(transactions, rules);
    const excludeHits = excludeRuleHits(forTransfers, excludeRules);
    const items = [
      // Platsen i användarens ordning (KK-58-C), null för mallregler. Listan är sorterad på namn.
      ...rules.map((r) => ({ ...toItem(r), position: r.position ?? null, hits: hits.get(r.id) ?? 0, category_archived: archived.has(r.categoryId) })),
      ...excludeRules.map((r) => ({ ...excludeItem(r), position: null, hits: excludeHits.get(r.id) ?? 0, category_archived: false })),
    ].sort((a, b) => a.pattern.localeCompare(b.pattern, "sv"));
    return json({ items }, 200);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}

/**
 * POST /api/rules med `action: "exclude"` (KK-39-C): en regel som gör att träffarna inte räknas. Den gäller
 * hela historiken direkt, så omräkningen körs när den sparas. `preview: true` räknar bara träffarna.
 */
async function createExcludeRule(input: Record<string, unknown>, env: { DB: D1Database }, sync: SyncDeps): Promise<Response> {
  const kind = kindFrom(input);
  const pattern = patternOf(input.pattern, kind ?? "prefix");
  if (kind === null || pattern === null || "category_id" in input || ("preview" in input && typeof input.preview !== "boolean")) return invalid();
  const match = MATCH[kind ?? "prefix"];
  try {
    const repo = ruleRepository(env.DB);
    if (input.preview === true) return json({ matches: await excludeMatches(env.DB, { id: "preview", match, pattern }) }, 200);
    const existing = (await repo.excludeRules()).find((r) => r.match === match && r.pattern === pattern);
    const rule: ExcludeRule = existing ?? { id: sync.newId(), match, pattern };
    if (!existing) {
      await repo.saveExclude(rule);
      await recomputeTransfers(env.DB);
    }
    return json({ rule: excludeItem(rule), matches: await excludeMatches(env.DB, rule) }, existing ? 200 : 201);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}

export async function createRule(request: Request, env: { DB: D1Database }, sync: SyncDeps): Promise<Response> {
  const input = await body(request);
  const action = input?.action ?? "categorize";
  if (input !== null && action === "exclude") return createExcludeRule(input, env, sync);
  const kind = input === null ? undefined : kindFrom(input);
  const pattern = patternOf(input?.pattern, kind ?? "prefix");
  const options = input === null ? null : flags(input);
  if (kind === null || pattern === null || options === null || action !== "categorize" || typeof input?.category_id !== "string") return invalid();
  const match = MATCH[kind ?? "prefix"];
  const categoryId = input.category_id;
  try {
    if (!(await usable(env.DB, categoryId))) return json({ error: "unknown_category" }, 400);
    const repo = ruleRepository(env.DB);
    // Finns redan en egen regel med samma mönster byter den kategori i stället, som vid "Gör alltid så".
    const existing = (await repo.list()).find((r) => r.source === "learned" && r.match === match && r.pattern === pattern);
    const rule: CategoryRule = existing ? { ...existing, categoryId } : { id: sync.newId(), match, pattern, categoryId, source: "learned" };
    if (options.preview) return await preview(env.DB, rule, options.overrideManual);
    await repo.save(rule);
    return await applied(env.DB, rule, existing ? 200 : 201, options.overrideManual);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}

export async function patchRule(request: Request, env: { DB: D1Database }, id: string): Promise<Response> {
  const input = await body(request);
  if (input === null || (!("pattern" in input) && !("category_id" in input) && !("match" in input))) return invalid();
  const kind = kindFrom(input);
  const options = flags(input);
  if (kind === null || options === null || options.preview || ("category_id" in input && typeof input.category_id !== "string")) return invalid();
  try {
    const repo = ruleRepository(env.DB);
    const exclude = (await repo.excludeRules()).find((r) => r.id === id);
    // Mönstret tolkas efter regelns slag efter ändringen: ett nytt slag gäller även det gamla mönstret.
    const current = exclude ?? (await repo.list()).find((r) => r.id === id);
    if (!current) return json({ error: "not_found" }, 404);
    const nextKind = kind ?? kindOf(current.match);
    const pattern = patternOf("pattern" in input ? input.pattern : current.pattern, nextKind);
    if (pattern === null) return invalid();
    if (exclude) {
      // En Räkna inte-regel har bara mönster och slag, och ändringen gäller hela historiken direkt (KK-39-C).
      if ("category_id" in input) return invalid();
      const rule = { ...exclude, pattern, match: MATCH[nextKind] };
      await repo.updateExclude(rule);
      await recomputeTransfers(env.DB);
      return json({ rule: excludeItem(rule), matches: await excludeMatches(env.DB, rule) }, 200);
    }
    // Är det inte en Räkna inte-regel är det en kategoriregel.
    const category = current as CategoryRule;
    const categoryId = typeof input.category_id === "string" ? input.category_id : category.categoryId;
    if (categoryId !== category.categoryId && !(await usable(env.DB, categoryId))) return json({ error: "unknown_category" }, 400);
    const rule = { ...category, pattern, categoryId, match: MATCH[nextKind] };
    await repo.update(rule);
    return await applied(env.DB, rule, 200, options.overrideManual);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}

export async function deleteRule(env: { DB: D1Database }, id: string): Promise<Response> {
  try {
    const repo = ruleRepository(env.DB);
    const exclude = (await repo.excludeRules()).some((r) => r.id === id);
    if (!(await repo.remove(id))) return json({ error: "not_found" }, 404);
    // Utan en Räkna inte-regel räknas dess träffar igen (KK-39-C).
    if (exclude) await recomputeTransfers(env.DB);
    return new Response(null, { status: 204 });
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}

/** Så många transaktioner som förhandsvisningen listar. Antalen räknas alltid på alla. */
export const PREVIEW_LIMIT = 100;

/**
 * GET /api/rules/{id}/matches: transaktionerna regeln gäller, nyast först, med vad som händer med var och
 * en om regeln appliceras (KK-18-C). Bankens text skickas som den är och visas som text i appen (KK-30).
 */
export async function getRuleMatches(env: { DB: D1Database }, id: string): Promise<Response> {
  try {
    const [rules, transactions] = await Promise.all([ruleRepository(env.DB).list(), transactionRepository(env.DB).forRulePreview()]);
    if (!rules.some((r) => r.id === id)) return json({ error: "not_found" }, 404);
    const byId = new Map(transactions.map((t) => [t.id, t]));
    const matches = ruleMatches(transactions, rules, id);
    const count = (effect: string) => matches.filter((m) => m.effect === effect).length;
    return json(
      {
        total: matches.length,
        change: count("change"),
        unchanged: count("unchanged"),
        manual: count("manual"),
        items: matches.slice(0, PREVIEW_LIMIT).flatMap((m) => {
          const t = byId.get(m.id);
          return t
            ? [{ id: t.id, transaction_date: t.transactionDate, name: t.counterparty || t.description, amount_minor: t.amountMinor, category_id: t.categoryId, effect: m.effect }]
            : [];
        }),
      },
      200,
    );
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}

/**
 * POST /api/rules/apply-all: alla regler över hela historiken. Med `{ preview: true }` sägs bara hur många
 * som skulle få ny kategori. Manuellt valda rörs aldrig, och ingen kategori tas bort (KK-18-C).
 */
export async function applyAll(request: Request, env: { DB: D1Database }): Promise<Response> {
  const input = await body(request);
  if (input === null || ("preview" in input && typeof input.preview !== "boolean")) return invalid();
  try {
    const store = transactionRepository(env.DB);
    const changes = applyAllRules(await store.categorizable(), await ruleRepository(env.DB).list());
    if (input.preview === true) return json({ would_update: changes.length }, 200);
    await store.setCategories(changes);
    return json({ updated: changes.length }, 200);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}

/**
 * POST /api/rules/reset (KK-51): ta bort alla regler och börja om. `{ preview: true }` räknar bara. `{ confirm: true }`
 * tar bort alla kategoriserande regler, mallens och egna, och alla Räkna inte-regler. Transaktionerna behåller sin
 * kategori, och det som en Räkna inte-regel höll utanför räknas igen. Regler som bara sätter inkomsttyp rörs inte.
 */
export async function resetRules(request: Request, env: { DB: D1Database }): Promise<Response> {
  const input = await body(request);
  if (input === null) return invalid();
  const { preview, confirm } = input;
  const valid = (v: unknown) => v === undefined || typeof v === "boolean";
  if (!valid(preview) || !valid(confirm) || (preview === true) === (confirm === true)) return invalid();
  try {
    const repo = ruleRepository(env.DB);
    if (preview === true) {
      const { categorize, exclude } = await repo.countAll();
      return json({ rules: categorize, exclude_rules: exclude }, 200);
    }
    await repo.removeAll();
    await recomputeTransfers(env.DB);
    return json({ reset: true }, 200);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}

/**
 * PUT /api/rules/order (KK-58-C): de egna reglernas ordning, den som vinner först. Ordningen avgör vilken regel som
 * vinner, så alla regler tillämpas direkt över historiken (KK-58-A). Manuellt valda rörs inte, och ingen kategori tas
 * bort. Ordningen måste innehålla varje egen kategoriregel exakt en gång, annars `invalid_order`.
 */
export async function putRuleOrder(request: Request, env: { DB: D1Database }): Promise<Response> {
  const input = await body(request);
  const order = input?.order;
  if (!Array.isArray(order) || !order.every((id): id is string => typeof id === "string")) return invalid();
  try {
    const repo = ruleRepository(env.DB);
    try {
      await repo.setOrder(order);
    } catch (error) {
      if (error instanceof RangeError) return json({ error: "invalid_order" }, 400);
      throw error;
    }
    const store = transactionRepository(env.DB);
    const changes = applyAllRules(await store.categorizable(), await repo.list());
    await store.setCategories(changes);
    return json({ updated: changes.length }, 200);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}
