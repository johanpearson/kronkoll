// Översikten (#31, KK-17): GET /api/overview?period=ÅÅÅÅ-MM. Saldo över valda konton, periodens in, ut
// och netto, kvar att spendera med kvar per dag, trenden för de 12 senaste perioderna och
// kopplingarnas status. Allt räknas i domänen (`domain/overview`) med samma regler som budgeten:
// interna överföringar räknas varken som in eller ut.
import { budgetRepository, categoryRepository, overviewRepository, settingsRepository } from "@kronkoll/adapter-d1";
import {
  budgetByMainCategory,
  budgetPeriodForKey,
  currentBudgetPeriod,
  daysBetween,
  leftToSpend,
  periodTotals,
  recentPeriods,
  todayInStockholm,
  totalBalance,
  trend,
  type BudgetPeriod,
} from "@kronkoll/domain";
import type { SyncDeps } from "./sync.ts";

/** Antal perioder i trenden (KK-17-C). */
export const TREND_PERIODS = 12;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

export async function getOverview(request: Request, env: { DB: D1Database }, sync: SyncDeps): Promise<Response> {
  const key = new URL(request.url).searchParams.get("period") ?? "current";
  try {
    const { budgetPeriodStartDay: startDay } = await settingsRepository(env.DB).get();
    let period: BudgetPeriod;
    try {
      period = key === "current" ? currentBudgetPeriod(sync.clock, startDay) : budgetPeriodForKey(key, startDay);
    } catch {
      return json({ error: "invalid_request" }, 400);
    }
    const periods = recentPeriods(period, startDay, TREND_PERIODS);
    const firstStart = periods[0]?.start ?? period.start;
    const budget = budgetRepository(env.DB);
    const overview = overviewRepository(env.DB);
    // Alla tolv perioders transaktioner i en hämtning, och domänen delar upp dem per period.
    const [{ transactions, splits }, lines, categories, accounts, allConnections] = await Promise.all([
      budget.actuals({ key: period.key, start: firstStart, end: period.end }),
      budget.lines(period.key),
      categoryRepository(env.DB).list(),
      overview.accounts(),
      overview.connections(),
    ]);
    const input = { transactions, splits, categories };
    const totals = periodTotals({ ...input, period });
    // Varje huvudkategori räknas en gång, även när både den och underkategorier har budget.
    const { totalBudgetMinor: budgetMinor } = budgetByMainCategory({ ...input, period, lines });
    const today = todayInStockholm(sync.clock);
    const left = leftToSpend({ period, today, budgetMinor, actualMinor: totals.expenseMinor });
    // En koppling som aldrig blev klar (avbruten med BankID) är ingen bank att visa.
    const connections = allConnections.filter((c) => c.status !== "pending_auth");
    const syncs = connections.flatMap((c) => (c.lastSuccessAt === null ? [] : [c.lastSuccessAt])).sort();
    return json(
      {
        period,
        balance_minor: totalBalance(accounts),
        income_minor: totals.incomeMinor,
        expense_minor: totals.expenseMinor,
        net_minor: totals.netMinor,
        budget_minor: budgetMinor,
        left_to_spend_minor: left.leftMinor,
        left_per_day_minor: left.perDayMinor,
        days_left: left.daysLeft,
        over: left.over,
        last_sync_at: syncs.at(-1) ?? null,
        connections: connections.map((c) => ({
          id: c.id,
          bank: c.bank,
          status: c.status,
          consent_expires_on: c.consentExpiresOn,
          consent_days_left: c.consentExpiresOn === null ? null : daysBetween(today, c.consentExpiresOn),
        })),
        trend: trend({ ...input, periods }).map((t) => ({ period: t.period, income_minor: t.incomeMinor, expense_minor: t.expenseMinor, net_minor: t.netMinor })),
      },
      200,
    );
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}
