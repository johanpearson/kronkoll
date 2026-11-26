// Underlag till budgetplaneraren (KK-42): GET och PUT /api/guidelines. Engångsperioderna gäller tills vidare och
// sparas som en helhet (PUT). GET räknar i domänen vid anropet: normalnivå per huvudkategori (median av de
// senaste 6 perioderna utan engångsperioder), fasta kostnader ur återkommande dragningar (KK-24-A), förväntad
// inkomst (median av lön och föräldrapenning de tre senaste månaderna som har inkomst) och utfallet hittills.
import { budgetRepository, categoryRepository, guidelineRepository, incomeRepository, insightsRepository, settingsRepository } from "@kronkoll/adapter-d1";
import {
  NORMAL_MONTHS,
  addDays,
  budgetPeriodForKey,
  categoryLevels,
  currentBudgetPeriod,
  medianMinor,
  recurringCharges,
  ruleKey,
  rollUpToMain,
  spendingByCategory,
  todayInStockholm,
  type BudgetPeriod,
} from "@kronkoll/domain";
import { readAccountFilter } from "./account-filter.ts";
import { previousKey } from "./insights.ts";
import type { SyncDeps } from "./sync.ts";

const PERIOD_KEY = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const MAX_ONE_OFF = 24;
const INCOME_MONTHS = 3;
const RECURRING_DAYS = 400;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

const invalid = () => json({ error: "invalid_request" }, 400);

export async function getGuidelines(request: Request, env: { DB: D1Database }, sync: SyncDeps): Promise<Response> {
  const url = new URL(request.url);
  const key = url.searchParams.get("period");
  const accountIds = readAccountFilter(url);
  if (accountIds === null) return invalid();
  try {
    const { budgetPeriodStartDay: startDay } = await settingsRepository(env.DB).get();
    let period: BudgetPeriod;
    try {
      // Utan period, och med "current" som appen skickar, är det den pågående perioden, som för budget.
      period = key === null || key === "current" ? currentBudgetPeriod(sync.clock, startDay) : budgetPeriodForKey(key, startDay);
    } catch {
      return invalid();
    }
    const today = todayInStockholm(sync.clock);
    const history = Array.from({ length: NORMAL_MONTHS }, (_, i) => budgetPeriodForKey(previousKey(period.key, NORMAL_MONTHS - i), startDay));
    const from = addDays(today, -RECURRING_DAYS);
    const budget = budgetRepository(env.DB);
    const categories = await categoryRepository(env.DB).list();
    // Planen räknas på huvudkategorier: underkategorierna summeras uppåt.
    const parentOf = new Map(categories.map((c) => [c.id, c.parentId]));
    const mainOf = (id: string) => parentOf.get(id) ?? id;
    const spendingOf = (p: BudgetPeriod, actuals: Awaited<ReturnType<typeof budget.actuals>>) => rollUpToMain(spendingByCategory({ period: p, ...actuals, categories }), parentOf);
    const [state, current, earlier, charges, income] = await Promise.all([
      guidelineRepository(env.DB).get(),
      budget.actuals(period, accountIds),
      Promise.all(history.map(async (p) => ({ key: p.key, spending: spendingOf(p, await budget.actuals(p, accountIds)) }))),
      insightsRepository(env.DB).charges(period.start < from ? period.start : from, period.end > today ? period.end : today, accountIds),
      incomeRepository(env.DB).monthly(previousKey(period.key, INCOME_MONTHS), previousKey(period.key, 1)),
    ]);
    const actual = spendingOf(period, current);
    const levels = categoryLevels(earlier, state.oneOffPeriods);
    // Förra periodens utfall per huvudkategori, för jämförelsen i planeraren (KK-42-B).
    const last = earlier.reduce<ReadonlyMap<string | null, number>>((_, p) => p.spending, new Map());

    // Fasta kostnader: återkommande dragningar per månad, och vilken kategori de hör till.
    const categoryOfGroup = new Map<string, string | null>();
    const recurring = recurringCharges(
      charges.filter((c) => c.date >= from).map((c) => {
        const group = ruleKey(c);
        categoryOfGroup.set(group, c.categoryId);
        return { ...c, counterpartyNorm: group, counterparty: c.counterparty !== "" ? c.counterparty : group };
      }),
      today,
    );
    const fixedByCategory = new Map<string, number>();
    let fixedMinor = 0;
    for (const r of recurring) {
      const monthly = Math.round(r.yearlyMinor / 12);
      fixedMinor += monthly;
      const categoryId = categoryOfGroup.get(r.counterpartyNorm) ?? null;
      if (categoryId !== null) fixedByCategory.set(mainOf(categoryId), (fixedByCategory.get(mainOf(categoryId)) ?? 0) + monthly);
    }

    const earnings = income.map((m) => m.salaryMinor + m.parentalBenefitMinor).filter((total) => total > 0);
    const expectedIncomeMinor = medianMinor(earnings);

    return json(
      {
        period,
        one_off_periods: state.oneOffPeriods,
        expected_income_minor: expectedIncomeMinor,
        fixed_minor: fixedMinor,
        categories: levels.map((l) => ({
          category_id: l.categoryId,
          average_minor: l.averageMinor,
          normal_minor: l.normalMinor,
          fixed_minor: Math.min(fixedByCategory.get(l.categoryId) ?? 0, l.normalMinor),
          actual_minor: actual.get(l.categoryId) ?? 0,
          last_minor: last.get(l.categoryId) ?? 0,
        })),
      },
      200,
    );
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}

const isPeriod = (value: unknown): value is string => typeof value === "string" && PERIOD_KEY.test(value);

/** Engångsperioderna, eller null om formen är fel. PUT ersätter hela listan. */
async function readOneOffPeriods(request: Request): Promise<string[] | null> {
  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== "object" || body === null) return null;
  const periods = (body as Record<string, unknown>)["one_off_periods"];
  if (!Array.isArray(periods) || periods.length > MAX_ONE_OFF || !(periods as unknown[]).every(isPeriod)) return null;
  const list = periods as string[];
  return new Set(list).size === list.length ? [...list] : null;
}

export async function putGuidelines(request: Request, env: { DB: D1Database }): Promise<Response> {
  const oneOffPeriods = await readOneOffPeriods(request);
  if (!oneOffPeriods) return invalid();
  try {
    await guidelineRepository(env.DB).save({ oneOffPeriods });
    return json({ one_off_periods: [...oneOffPeriods].sort() }, 200);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}
