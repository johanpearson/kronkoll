// Insikter (#41, KK-24): GET /api/insights?period=ÅÅÅÅ-MM, utan period den pågående. Allt räknas i domänen
// vid anropet: avvikelser mot de tre föregående perioderna (KK-24-B), periodens största utgifter och
// utgifter per huvudkategori (KK-24-C), och återkommande dragningar de senaste 400 dagarna (KK-24-A).
// Skandia skickar ingen motpart, så dragningar grupperas på `ruleKey` (motparten, annars meddelandet).
import { budgetRepository, categoryRepository, insightsRepository, settingsRepository } from "@kronkoll/adapter-d1";
import {
  addDays,
  addMonths,
  budgetPeriodForKey,
  currentBudgetPeriod,
  recurringCharges,
  ruleKey,
  spendingAnomalies,
  spendingByCategory,
  spendingByMainCategory,
  todayInStockholm,
  topExpenses,
  type BudgetPeriod,
} from "@kronkoll/domain";
import type { SyncDeps } from "./sync.ts";

const HISTORY_PERIODS = 3;
const RECURRING_DAYS = 400;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

const previousKey = (key: string, back: number) => {
  const { year, month } = addMonths({ year: Number(key.slice(0, 4)), month: Number(key.slice(5, 7)) }, -back);
  return `${String(year)}-${String(month).padStart(2, "0")}`;
};

export async function getInsights(request: Request, env: { DB: D1Database }, sync: SyncDeps): Promise<Response> {
  const key = new URL(request.url).searchParams.get("period");
  try {
    const { budgetPeriodStartDay: startDay } = await settingsRepository(env.DB).get();
    let period: BudgetPeriod;
    try {
      period = key === null ? currentBudgetPeriod(sync.clock, startDay) : budgetPeriodForKey(key, startDay);
    } catch {
      return json({ error: "invalid_request" }, 400);
    }
    const history = Array.from({ length: HISTORY_PERIODS }, (_, i) => budgetPeriodForKey(previousKey(period.key, i + 1), startDay));
    const today = todayInStockholm(sync.clock);
    const from = addDays(today, -RECURRING_DAYS);
    const budget = budgetRepository(env.DB);
    const [categories, current, earlier, charges] = await Promise.all([
      categoryRepository(env.DB).list(),
      budget.actuals(period),
      Promise.all(history.map((p) => budget.actuals(p))),
      insightsRepository(env.DB).charges(period.start < from ? period.start : from, period.end > today ? period.end : today),
    ]);

    const input = { period, ...current, categories };
    const spendingOf = (p: BudgetPeriod, actuals: typeof current) => spendingByCategory({ period: p, ...actuals, categories });
    const anomalies = spendingAnomalies(spendingOf(period, current), earlier.map((a, i) => spendingOf(history[i] as BudgetPeriod, a)));
    const names = new Map(charges.map((c) => [c.id, c.counterparty !== "" ? c.counterparty : c.description]));
    const recurring = recurringCharges(
      charges.filter((c) => c.date >= from).map((c) => {
        const group = ruleKey(c);
        return { ...c, counterpartyNorm: group, counterparty: c.counterparty !== "" ? c.counterparty : group };
      }),
      today,
    );

    return json(
      {
        period,
        history_periods: history.map((p) => p.key),
        anomalies: anomalies.map((a) => ({ category_id: a.categoryId, actual_minor: a.actualMinor, baseline_minor: a.baselineMinor, diff_minor: a.diffMinor, pct: a.pct })),
        recurring: recurring.map((r) => ({
          name: r.counterparty,
          interval: r.interval,
          amount_minor: r.amountMinor,
          last_date: r.lastDate,
          next_expected: r.nextExpected,
          yearly_minor: r.yearlyMinor,
          occurrences: r.occurrences,
        })),
        recurring_yearly_minor: recurring.reduce((sum, r) => sum + r.yearlyMinor, 0),
        top_expenses: topExpenses(input).map((t) => ({ id: t.id, date: t.date, name: names.get(t.id) ?? "", amount_minor: t.amountMinor, category_id: t.categoryId, split: t.split })),
        top_categories: spendingByMainCategory(input).map((c) => ({ category_id: c.categoryId, amount_minor: c.amountMinor })),
      },
      200,
    );
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}
