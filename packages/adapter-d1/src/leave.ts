/**
 * Planerad föräldraledighet och Försäkringskassans årsparametrar i D1 (KK-23, #40). Uppskattningen och
 * påverkan räknas i domänen (`estimateLeaveIncome`, `leaveImpact`), här finns bara det de behöver.
 */
import type { D1Database } from "@cloudflare/workers-types";
import type { IncomeParameters, LeavePeriod } from "@kronkoll/domain";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { incomeParameters, leavePeriods } from "./schema.ts";

export interface LeavePeriodRecord extends LeavePeriod {
  readonly id: string;
}

const columns = {
  id: leavePeriods.id,
  from: leavePeriods.fromDate,
  to: leavePeriods.toDate,
  daysPerWeek: leavePeriods.daysPerWeek,
  sgiAnnualMinor: leavePeriods.sgiAnnualMinor,
  employerTopupPct: leavePeriods.employerTopupPct,
  taxRatePct: leavePeriods.taxRatePct,
  overrideNetMonthlyMinor: leavePeriods.overrideNetMonthlyMinor,
};

export function leaveRepository(d1: D1Database) {
  const db = drizzle(d1);
  return {
    /** Alla perioder, tidigast först. */
    async list(): Promise<LeavePeriodRecord[]> {
      return db.select(columns).from(leavePeriods).orderBy(asc(leavePeriods.fromDate), asc(leavePeriods.id)).all();
    },

    async get(id: string): Promise<LeavePeriodRecord | null> {
      const [row] = await db.select(columns).from(leavePeriods).where(eq(leavePeriods.id, id)).all();
      return row ?? null;
    },

    async create(period: LeavePeriod, id: string): Promise<void> {
      const { from, to, ...rest } = period;
      await db.insert(leavePeriods).values({ id, fromDate: from, toDate: to, ...rest }).run();
    },

    /** Tar bort en period. Falskt om den inte finns. */
    async remove(id: string): Promise<boolean> {
      const result = await d1.prepare(`DELETE FROM leave_periods WHERE id = ?`).bind(id).run();
      return result.meta.changes > 0;
    },

    /** Årsparametrarna, äldsta året först. Källan behövs inte för beräkningen. */
    async parameters(): Promise<IncomeParameters[]> {
      return db
        .select({
          year: incomeParameters.year,
          priceBaseAmountMinor: incomeParameters.priceBaseAmountMinor,
          sgiCapMultiplier: incomeParameters.sgiCapMultiplier,
          benefitRate: incomeParameters.benefitRate,
          sgiFactor: incomeParameters.sgiFactor,
        })
        .from(incomeParameters)
        .orderBy(asc(incomeParameters.year))
        .all();
    },
  };
}
