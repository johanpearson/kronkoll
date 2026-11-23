// Riktlinjer och sparläge (KK-42): GET och PUT /api/guidelines. Läget, sparmålet, manuella nivåer och
// engångsperioder gäller tills vidare och sparas som en helhet (PUT). GET räknar i domänen vid anropet:
// normalnivå per huvudkategori (median av de senaste 6 perioderna utan engångsperioder), fasta kostnader ur
// återkommande dragningar (KK-24-A), förväntad inkomst (median av lön och föräldrapenning de tre senaste
// månaderna som har inkomst), utrymmet att spendera fritt och vad som är kvar hittills i perioden.
import { budgetRepository, categoryRepository, guidelineRepository, incomeRepository, insightsRepository, settingsRepository, type GuidelineMode } from "@kronkoll/adapter-d1";
import {
  NORMAL_MONTHS,
  addDays,
  budgetPeriodForKey,
  categoryLevels,
  currentBudgetPeriod,
  freeSpending,
  guidelineLines,
  isOverPace,
  medianMinor,
  perDayMinor,
  recurringCharges,
  remainingFree,
  ruleKey,
  rollUpToMain,
  spendingByCategory,
  todayInStockholm,
  type BudgetPeriod,
} from "@kronkoll/domain";
import { readAccountFilter } from "./account-filter.ts";
import { previousKey } from "./insights.ts";
import type { SyncDeps } from "./sync.ts";

const MODES = new Set<string>(["none", "budget", "saving"] satisfies GuidelineMode[]);
const PERIOD_KEY = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const MAX_OVERRIDES = 200;
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
    // Riktlinjerna räknas på huvudkategorier: underkategorierna summeras uppåt.
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
    const saving = state.mode === "saving";
    const free = freeSpending({ incomeMinor: expectedIncomeMinor, fixedMinor, savingGoalMinor: saving ? state.savingGoalMinor : 0 });
    const overrides = new Map(state.overrides.map((o) => [o.categoryId, o.amountMinor]));
    const lines = guidelineLines({ levels, fixedByCategory, freeMinor: free.freeMinor, overrides });
    const remainingMinor = remainingFree(free.freeMinor, lines, actual);

    return json(
      {
        period,
        mode: state.mode,
        saving_goal_minor: state.savingGoalMinor,
        one_off_periods: state.oneOffPeriods,
        expected_income_minor: expectedIncomeMinor,
        fixed_minor: fixedMinor,
        feasible: free.feasible,
        shortfall_minor: free.shortfallMinor,
        free_to_spend_minor: free.freeMinor,
        remaining_free_minor: remainingMinor,
        per_day_minor: perDayMinor(remainingMinor, today, period),
        categories: lines.map((l) => {
          const spent = actual.get(l.categoryId) ?? 0;
          return {
            category_id: l.categoryId,
            average_minor: l.averageMinor,
            normal_minor: l.normalMinor,
            fixed_minor: l.fixedMinor,
            saving_minor: l.savingMinor,
            override_minor: overrides.get(l.categoryId) ?? null,
            actual_minor: spent,
            // Takten gäller det rörliga: en hyra som dras första dagen är inte "över takt".
            over_pace: saving && isOverPace({ levelMinor: l.savingMinor - l.fixedMinor, actualMinor: Math.max(0, spent - l.fixedMinor), today, period }),
          };
        }),
      },
      200,
    );
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}

interface GuidelineRequest {
  mode: GuidelineMode;
  savingGoalMinor: number;
  overrides: { categoryId: string; amountMinor: number }[];
  oneOffPeriods: string[];
}

const isAmount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** Begäran, eller null om formen är fel. Alla fyra fälten krävs eftersom PUT ersätter allt. */
async function readGuidelines(request: Request): Promise<GuidelineRequest | null> {
  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== "object" || body === null) return null;
  const { mode, saving_goal_minor: goal, overrides: rawOverrides, one_off_periods: rawPeriods } = body as Record<string, unknown>;
  if (typeof mode !== "string" || !MODES.has(mode) || !isAmount(goal)) return null;
  if (!Array.isArray(rawOverrides) || rawOverrides.length > MAX_OVERRIDES || !Array.isArray(rawPeriods) || rawPeriods.length > MAX_ONE_OFF) return null;
  const overrides: GuidelineRequest["overrides"] = [];
  for (const raw of rawOverrides as unknown[]) {
    if (typeof raw !== "object" || raw === null) return null;
    const { category_id: categoryId, amount_minor: amountMinor } = raw as Record<string, unknown>;
    if (typeof categoryId !== "string" || !isAmount(amountMinor)) return null;
    overrides.push({ categoryId, amountMinor });
  }
  const oneOffPeriods = rawPeriods as unknown[];
  if (!oneOffPeriods.every((p): p is string => typeof p === "string" && PERIOD_KEY.test(p))) return null;
  if (new Set(overrides.map((o) => o.categoryId)).size !== overrides.length || new Set(oneOffPeriods).size !== oneOffPeriods.length) return null;
  return { mode: mode as GuidelineMode, savingGoalMinor: goal, overrides, oneOffPeriods: [...oneOffPeriods] };
}

export async function putGuidelines(request: Request, env: { DB: D1Database }): Promise<Response> {
  const guidelines = await readGuidelines(request);
  if (!guidelines) return invalid();
  try {
    // Bara huvudkategorier för utgifter som inte är arkiverade går att ge en manuell nivå.
    const allowed = new Set((await categoryRepository(env.DB).list()).filter((c) => c.kind === "expense" && !c.archived && c.parentId === null).map((c) => c.id));
    if (!guidelines.overrides.every((o) => allowed.has(o.categoryId))) return json({ error: "unknown_category" }, 400);
    await guidelineRepository(env.DB).save(guidelines);
    return json({ mode: guidelines.mode }, 200);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}
