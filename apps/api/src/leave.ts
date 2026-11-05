// Planerad föräldraledighet (#40, KK-23): GET och POST /api/leave-periods, DELETE /api/leave-periods/{id}.
// Uppskattningen räknas i domänen (estimateLeaveIncome) med Försäkringskassans årsparametrar och sparas inte.
// En normal månad är snittet av lönen de senaste tre hela kalendermånaderna. Underskottet jämför inkomsten
// med budgeten för den pågående perioden, och sparmålens prognos räknas om med lägre sparande (leaveImpact).
// Sparat och takt per mål kommer från goalStatus, samma som i GET /api/goals.
import { budgetRepository, categoryRepository, goalRepository, incomeRepository, leaveRepository, settingsRepository, type LeavePeriodRecord } from "@kronkoll/adapter-d1";
import {
  addMonths,
  budgetByMainCategory,
  compareWithNormal,
  currentBudgetPeriod,
  daysBetween,
  estimateLeaveIncome,
  leaveImpact,
  todayInStockholm,
  yearMonthOf,
  type GoalForecast,
  type ImpactGoal,
  type LeavePeriod,
} from "@kronkoll/domain";
import { goalStatus } from "./goals.ts";
import type { SyncDeps } from "./sync.ts";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
/** Längre perioder än två år planeras i flera delar. Gränsen håller också nere CPU-tiden. */
const MAX_DAYS = 731;
const NORMAL_MONTHS = 3;
const DISCLAIMER = "Uppskattning – inte ett besked från Försäkringskassan";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

const invalid = () => json({ error: "invalid_request" }, 400);
const isDate = (value: unknown): value is string => typeof value === "string" && ISO_DATE.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().startsWith(value);
const inRange = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const isMinor = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const monthKey = (ym: { year: number; month: number }) => `${String(ym.year)}-${String(ym.month).padStart(2, "0")}`;

/** Det som är samma för alla perioder: årsparametrar, en normal månads lön och budgeten. */
async function context(db: D1Database, sync: SyncDeps) {
  const today = todayInStockholm(sync.clock);
  const thisMonth = yearMonthOf(today);
  const budget = budgetRepository(db);
  const { budgetPeriodStartDay } = await settingsRepository(db).get();
  const period = currentBudgetPeriod(sync.clock, budgetPeriodStartDay);
  const [parameters, income, lines, categories, goalRecords] = await Promise.all([
    leaveRepository(db).parameters(),
    incomeRepository(db).monthly(monthKey(addMonths(thisMonth, -NORMAL_MONTHS)), monthKey(addMonths(thisMonth, -1))),
    budget.lines(period.key),
    categoryRepository(db).list(),
    goalRepository(db).list(),
  ]);
  const goals = await Promise.all(
    goalRecords.map(async (g): Promise<ImpactGoal & { name: string }> => {
      const status = await goalStatus(db, g, today);
      return { id: g.id, name: g.name, targetMinor: g.targetMinor, savedMinor: status.savedMinor, monthlyRateMinor: status.monthlyRateMinor, targetDate: g.targetDate };
    }),
  );
  const normalNetMonthlyMinor = Math.round(income.reduce((sum, m) => sum + m.salaryMinor, 0) / NORMAL_MONTHS);
  const monthlyBudgetMinor = budgetByMainCategory({ period, transactions: [], splits: new Map(), categories, lines }).totalBudgetMinor;
  return { today, parameters, normalNetMonthlyMinor, monthlyBudgetMinor, goals };
}

const reachPeriod = (f: GoalForecast) => (f.kind === "eta" ? f.reachedIn : null);
const onTrack = (f: GoalForecast) => (f.kind === "eta" ? f.onTrack : f.kind === "reached" ? true : f.requiredPerMonthMinor === null ? null : false);

function view(period: LeavePeriodRecord, ctx: Awaited<ReturnType<typeof context>>) {
  const months = estimateLeaveIncome(period, ctx.parameters);
  const compared = compareWithNormal(months, ctx.normalNetMonthlyMinor);
  const impact = leaveImpact({ months: compared, monthlyBudgetMinor: ctx.monthlyBudgetMinor, goals: ctx.goals, today: ctx.today });
  const names = new Map(ctx.goals.map((g) => [g.id, g.name]));
  return {
    id: period.id,
    from: period.from,
    to: period.to,
    days_per_week: period.daysPerWeek,
    sgi_annual_minor: period.sgiAnnualMinor,
    employer_topup_pct: period.employerTopupPct,
    tax_rate_pct: period.taxRatePct,
    override_net_monthly_minor: period.overrideNetMonthlyMinor,
    estimate: {
      disclaimer: DISCLAIMER,
      normal_net_monthly_minor: ctx.normalNetMonthlyMinor,
      months: months.map((m, i) => ({
        period: m.month,
        leave_days: m.leaveDays,
        withdrawal_days: m.withdrawalDays,
        benefit_gross_minor: m.benefitGrossMinor,
        topup_gross_minor: m.topupGrossMinor,
        net_minor: m.netMinor,
        source: m.source,
        params_year: m.parametersYear,
        params_fallback: m.parametersFallback,
        income_minor: compared[i]?.incomeMinor ?? m.netMinor,
        delta_vs_normal_minor: compared[i]?.differenceMinor ?? 0,
      })),
    },
    impacts: [
      ...impact.months.map((m) => ({ type: "budget", period: m.month, budget_minor: m.budgetMinor, income_minor: m.incomeMinor, shortfall_minor: m.shortfallMinor })),
      ...impact.goals.map((g) => ({
        type: "goal",
        goal_id: g.id,
        name: names.get(g.id) ?? "",
        lost_saving_minor: g.lostSavingMinor,
        delay_months: g.monthsLater,
        reach_period_before: reachPeriod(g.before),
        reach_period_after: reachPeriod(g.after),
        on_track_before: onTrack(g.before),
        on_track_after: onTrack(g.after),
      })),
    ],
  };
}

export async function listLeavePeriods(env: { DB: D1Database }, sync: SyncDeps): Promise<Response> {
  try {
    const [periods, ctx] = await Promise.all([leaveRepository(env.DB).list(), context(env.DB, sync)]);
    return json({ items: periods.map((p) => view(p, ctx)) }, 200);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}

/** Perioden ur begäran, eller null om formen är fel. */
async function readPeriod(request: Request): Promise<LeavePeriod | null> {
  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  const { from, to, days_per_week: days, sgi_annual_minor: sgi, employer_topup_pct: topup = 0, tax_rate_pct: tax, override_net_monthly_minor: override = null } = b;
  if (!isDate(from) || !isDate(to) || !inRange(days, 0, 7) || !isMinor(sgi) || !inRange(topup, 0, 100) || !inRange(tax, 0, 100)) return null;
  if (override !== null && !isMinor(override)) return null;
  return { from, to, daysPerWeek: days, sgiAnnualMinor: sgi, employerTopupPct: topup, taxRatePct: tax, overrideNetMonthlyMinor: override };
}

export async function createLeavePeriod(request: Request, env: { DB: D1Database }, sync: SyncDeps): Promise<Response> {
  const period = await readPeriod(request);
  if (!period) return invalid();
  if (period.to < period.from) return json({ error: "to_before_from" }, 422);
  if (daysBetween(period.from, period.to) >= MAX_DAYS) return json({ error: "period_too_long" }, 422);
  try {
    const id = sync.newId();
    await leaveRepository(env.DB).create(period, id);
    return json(view({ id, ...period }, await context(env.DB, sync)), 201);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}

export async function deleteLeavePeriod(env: { DB: D1Database }, id: string): Promise<Response> {
  try {
    return (await leaveRepository(env.DB).remove(id)) ? new Response(null, { status: 204 }) : json({ error: "not_found" }, 404);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}
