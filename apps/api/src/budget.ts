// Budget per kategori (#33, KK-20, KK-34): GET och PUT /api/budgets/{period}. Utfallet räknas i
// domänen (`budgetOutcome`): bara utgifter, interna överföringar uteslutna, uppdelningar per del och en
// huvudkategoris budget täcker underkategorier utan egen budget.
import { budgetRepository, categoryRepository, settingsRepository, type BudgetSource } from "@kronkoll/adapter-d1";
import { budgetOutcome, budgetPeriodForKey, currentBudgetPeriod, spendingByCategory, type BudgetLineInput, type BudgetPeriod } from "@kronkoll/domain";
import type { SyncDeps } from "./sync.ts";

const SOURCES = new Set<string>(["manual", "copy_previous", "average_3m"] satisfies BudgetSource[]);
const MAX_LINES = 200;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

const invalid = () => json({ error: "invalid_request" }, 400);

/** Perioden för en nyckel som "2026-11", eller den pågående för "current". Null om nyckeln är ogiltig. */
async function periodFor(db: D1Database, key: string, sync: SyncDeps): Promise<BudgetPeriod | null> {
  const { budgetPeriodStartDay } = await settingsRepository(db).get();
  try {
    return key === "current" ? currentBudgetPeriod(sync.clock, budgetPeriodStartDay) : budgetPeriodForKey(key, budgetPeriodStartDay);
  } catch {
    return null;
  }
}

export async function getBudget(env: { DB: D1Database }, key: string, sync: SyncDeps): Promise<Response> {
  try {
    const period = await periodFor(env.DB, key, sync);
    if (!period) return invalid();
    const repo = budgetRepository(env.DB);
    const [{ transactions, splits }, lines, categories] = await Promise.all([repo.actuals(period), repo.lines(period.key), categoryRepository(env.DB).list()]);
    const input = { period, transactions, splits, categories };
    const outcome = budgetOutcome({ ...input, lines });
    const spending = [...spendingByCategory(input)]
      .map(([categoryId, actual]) => ({ category_id: categoryId, actual_minor: actual }))
      .sort((a, b) => (a.category_id ?? "").localeCompare(b.category_id ?? ""));
    return json(
      {
        period,
        lines: outcome.lines.map((l) => ({
          category_id: l.categoryId,
          budget_minor: l.budgetMinor,
          actual_minor: l.actualMinor,
          remaining_minor: l.remainingMinor,
          percent: l.percent,
          over: l.over,
        })),
        unbudgeted_minor: outcome.unbudgetedMinor,
        total_budget_minor: outcome.totalBudgetMinor,
        total_actual_minor: outcome.totalActualMinor,
        excluded_internal_minor: outcome.excludedInternalMinor,
        spending,
      },
      200,
    );
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}

/** Raderna och källan ur begäran, eller null om formen är fel. */
async function readBudget(request: Request): Promise<{ lines: BudgetLineInput[]; source: BudgetSource } | null> {
  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== "object" || body === null || !("lines" in body) || !Array.isArray(body.lines) || body.lines.length > MAX_LINES) return null;
  const source = "source" in body ? body.source : "manual";
  if (typeof source !== "string" || !SOURCES.has(source)) return null;
  const lines: BudgetLineInput[] = [];
  for (const raw of body.lines as unknown[]) {
    if (typeof raw !== "object" || raw === null || !("category_id" in raw) || !("amount_minor" in raw)) return null;
    const { category_id: categoryId, amount_minor: amountMinor } = raw;
    if (typeof categoryId !== "string" || !Number.isSafeInteger(amountMinor) || (amountMinor as number) < 0) return null;
    lines.push({ categoryId, amountMinor: amountMinor as number });
  }
  if (new Set(lines.map((l) => l.categoryId)).size !== lines.length) return null;
  return { lines, source: source as BudgetSource };
}

export async function putBudget(request: Request, env: { DB: D1Database }, key: string, sync: SyncDeps): Promise<Response> {
  const budget = await readBudget(request);
  if (!budget) return invalid();
  try {
    const period = await periodFor(env.DB, key, sync);
    if (!period) return invalid();
    // Bara utgiftskategorier som inte är arkiverade går att budgetera.
    const allowed = new Set((await categoryRepository(env.DB).list()).filter((c) => c.kind === "expense" && !c.archived).map((c) => c.id));
    if (!budget.lines.every((l) => allowed.has(l.categoryId))) return json({ error: "unknown_category" }, 400);
    await budgetRepository(env.DB).replace(period.key, budget.lines, budget.source);
    return json({ period: period.key, lines: budget.lines.length }, 200);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}
