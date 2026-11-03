// Byta kategori (#32, KK-18-B, KK-18-C): PATCH /api/transactions/{id} sätter en manuell kategori och
// kan lära in en regel ("Gör alltid så"). Regeln ändrar ingen historik förrän användaren väljer det
// med POST /api/rules/{id}/apply. Manuella transaktioner rörs aldrig av regler.
import { categoryRepository, ruleRepository, transactionRepository } from "@kronkoll/adapter-d1";
import { learnFromManualChoice, ruleReach, type RuleReach } from "@kronkoll/domain";
import type { SyncDeps } from "./sync.ts";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

/**
 * Kategorin, om en regel ska läras in, och hur mycket av namnet regeln gäller (`rule_pattern`, valfritt,
 * bara med `learn_rule`). Null om formen är fel. Att mönstret är en början av namnet avgör domänen.
 */
async function readBody(request: Request): Promise<{ categoryId: string; learn: boolean; pattern: string | undefined } | null> {
  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== "object" || body === null || !("category_id" in body)) return null;
  const { category_id: categoryId } = body;
  const learn = "learn_rule" in body ? body.learn_rule : false;
  const pattern = "rule_pattern" in body ? body.rule_pattern : undefined;
  if (typeof categoryId !== "string" || categoryId === "" || typeof learn !== "boolean") return null;
  if (pattern !== undefined && (typeof pattern !== "string" || !learn)) return null;
  return { categoryId, learn, pattern };
}

export async function setCategory(request: Request, env: { DB: D1Database }, sync: SyncDeps, id: string): Promise<Response> {
  const input = await readBody(request);
  if (!input) return json({ error: "invalid_request" }, 400);
  try {
    if (!(await categoryRepository(env.DB).list()).some((c) => c.id === input.categoryId)) return json({ error: "unknown_category" }, 400);
    const store = transactionRepository(env.DB);
    const transaction = await store.get(id);
    if (!transaction) return json({ error: "not_found" }, 404);
    const rulesRepo = ruleRepository(env.DB);
    const rules = await rulesRepo.list();
    let rule;
    try {
      ({ rule } = learnFromManualChoice({
        transaction,
        categoryId: input.categoryId,
        alwaysDoThis: input.learn,
        ...(input.pattern === undefined ? {} : { pattern: input.pattern }),
        rules,
        newId: sync.newId,
      }));
    } catch {
      return json({ error: "invalid_pattern" }, 400);
    }
    await store.setManualCategory(id, input.categoryId);
    let reach: RuleReach = { changes: [], protectedManual: 0 };
    if (rule) {
      await rulesRepo.save(rule);
      // Den här transaktionen är nu manuell och räknas inte med.
      const others = (await store.categorizable()).filter((t) => t.id !== id);
      reach = ruleReach(others, [...rules.filter((r) => r.id !== rule.id), rule], rule.id);
    }
    return json(
      {
        transaction: { id, category_id: input.categoryId, category_source: "manual" },
        rule: rule && { id: rule.id, match: rule.match, pattern: rule.pattern, category_id: rule.categoryId },
        retroactive_candidates: reach.changes.length,
        protected_manual: reach.protectedManual,
      },
      200,
    );
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}

export async function applyRule(env: { DB: D1Database }, ruleId: string): Promise<Response> {
  try {
    const rules = await ruleRepository(env.DB).list();
    if (!rules.some((r) => r.id === ruleId)) return json({ error: "not_found" }, 404);
    const store = transactionRepository(env.DB);
    const { changes, protectedManual } = ruleReach(await store.categorizable(), rules, ruleId);
    await store.setCategories(changes);
    return json({ updated: changes.length, skipped_manual: protectedManual }, 200);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}
