// Ändra inkomsttyp (#40, KK-22-A): PATCH /api/transactions/{id} med { income_type }. Klassningen blir manuell
// och rörs aldrig av regler. Den lär alltid in en regel på namnet (learnIncomeFromManualChoice), som genast
// gäller övriga inbetalningar som inte är manuella, precis som synken gör.
import { incomeRepository, transactionRepository } from "@kronkoll/adapter-d1";
import { applyIncomeRules, learnIncomeFromManualChoice, type IncomeType } from "@kronkoll/domain";
import type { SyncDeps } from "./sync.ts";

const TYPES = new Set<string>(["salary", "parental_benefit", "other"] satisfies IncomeType[]);

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

/** Sant om begäran gäller inkomsttyp och inte kategori, så att routern kan välja rätt hanterare. */
export function isIncomeTypeRequest(body: unknown): boolean {
  return typeof body === "object" && body !== null && "income_type" in body && !("category_id" in body);
}

export async function setIncomeType(request: Request, env: { DB: D1Database }, sync: SyncDeps, id: string): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);
  const type = typeof body === "object" && body !== null && "income_type" in body ? body.income_type : null;
  if (typeof type !== "string" || !TYPES.has(type)) return json({ error: "invalid_request" }, 400);
  const incomeType = type as IncomeType;
  try {
    if (!(await transactionRepository(env.DB).get(id))) return json({ error: "not_found" }, 404);
    const repo = incomeRepository(env.DB);
    const [incoming, rules] = await Promise.all([repo.incoming(), repo.rules()]);
    const transaction = incoming.find((t) => t.id === id);
    if (!transaction) return json({ error: "not_income" }, 422);
    const { rule } = learnIncomeFromManualChoice({ transaction, incomeType, rules, newId: sync.newId });
    await repo.setIncome([{ id, incomeType, incomeSource: "manual" }]);
    let updated = 0;
    if (rule) {
      await repo.saveRule(rule);
      const others = incoming.filter((t) => t.id !== id);
      const changes = applyIncomeRules(others, [...rules.filter((r) => r.id !== rule.id), rule]);
      await repo.setIncome(changes);
      updated = changes.length;
    }
    return json(
      {
        transaction: { id, income_type: incomeType, income_source: "manual" },
        rule: rule && { id: rule.id, match: rule.match, pattern: rule.pattern, income_type: rule.incomeType },
        updated,
      },
      200,
    );
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}
