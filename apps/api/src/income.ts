// Inkomst per månad och typ (#40, KK-22-B): GET /api/income?from=ÅÅÅÅ-MM&to=ÅÅÅÅ-MM. Utan parametrar ges de
// senaste 12 kalendermånaderna, den pågående inräknad. Högst 24 månader. Månader utan inkomst ges som noll,
// så att diagrammet alltid har en stapel per månad. Inbetalningarna klassas i synken (sync.ts).
import { incomeRepository } from "@kronkoll/adapter-d1";
import { addMonths, todayInStockholm, yearMonthOf, type YearMonth } from "@kronkoll/domain";
import type { SyncDeps } from "./sync.ts";

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/u;
const DEFAULT_MONTHS = 12;
const MAX_MONTHS = 24;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

const key = (ym: YearMonth) => `${String(ym.year)}-${String(ym.month).padStart(2, "0")}`;
const index = (ym: YearMonth) => ym.year * 12 + ym.month;

function parseMonth(value: string | null): YearMonth | null {
  const match = value === null ? null : MONTH.exec(value);
  return match ? { year: Number(match[1]), month: Number(match[2]) } : null;
}

export async function getIncome(request: Request, env: { DB: D1Database }, sync: SyncDeps): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const now = yearMonthOf(todayInStockholm(sync.clock));
  const rawFrom = params.get("from");
  const rawTo = params.get("to");
  const to = rawTo === null ? now : parseMonth(rawTo);
  const from = rawFrom === null ? (to && addMonths(to, 1 - DEFAULT_MONTHS)) : parseMonth(rawFrom);
  if (!from || !to || index(from) > index(to) || index(to) - index(from) >= MAX_MONTHS) return json({ error: "invalid_request" }, 400);
  try {
    const rows = new Map((await incomeRepository(env.DB).monthly(key(from), key(to))).map((m) => [m.month, m]));
    const months = Array.from({ length: index(to) - index(from) + 1 }, (_, i) => {
      const period = key(addMonths(from, i));
      const row = rows.get(period);
      return { period, salary_minor: row?.salaryMinor ?? 0, parental_benefit_minor: row?.parentalBenefitMinor ?? 0, other_minor: row?.otherMinor ?? 0 };
    });
    return json({ months }, 200);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}
