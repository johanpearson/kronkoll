/**
 * Vad en planerad föräldraledighet gör med budgeten och sparmålen (KK-23-C, flöde F-leave).
 *
 * - Kvar att spendera: varje berörd månad jämförs budgeten med inkomsten, och underskottet visas.
 * - Sparmål: under ledigheten sparas samma andel av takten som inkomsten är av en normal månad, avrundat
 *   nedåt till hela ören. Mer än normalt ger inget extra. Bortfallet dras från det sparade och prognosen
 *   görs om med `forecastGoal`, tills de ledighetsmånader som ligger före målet inte längre ändras.
 *
 * Alla belopp är heltal öre (D-money).
 */
import { yearMonthOf } from "./calendar.ts";
import { forecastGoal, type GoalForecast, type GoalForecastInput } from "./goals.ts";
import type { MonthComparison } from "./income-forecast.ts";
import { assertMinor } from "./money.ts";

export type ImpactGoal = Omit<GoalForecastInput, "today"> & { readonly id: string };

export interface LeaveImpactInput {
  /** Från `compareWithNormal`. */
  readonly months: readonly MonthComparison[];
  readonly monthlyBudgetMinor: number;
  readonly goals: readonly ImpactGoal[];
  readonly today: string;
}

export interface MonthImpact {
  readonly month: string;
  readonly incomeMinor: number;
  readonly budgetMinor: number;
  /** Budget minus inkomst, 0 när inkomsten räcker. */
  readonly shortfallMinor: number;
}

export interface GoalImpact {
  readonly id: string;
  readonly before: GoalForecast;
  readonly after: GoalForecast;
  /** Sparande som uteblir under ledigheten innan målet nås. */
  readonly lostSavingMinor: number;
  /** Hur många månader senare målet nås, null om det inte nås före eller efter. */
  readonly monthsLater: number | null;
}

export interface LeaveImpact {
  readonly months: readonly MonthImpact[];
  readonly goals: readonly GoalImpact[];
}

function monthIndex(yyyyMm: string): number {
  const { year, month } = yearMonthOf(`${yyyyMm}-01`);
  return year * 12 + month;
}
const horizon = (f: GoalForecast) => (f.kind === "eta" ? f.months : 0);

/** Sparande som uteblir varje ledighetsmånad, med månaden räknad från i dag (1 = nästa månad). */
function lostPerMonth(months: readonly MonthComparison[], rate: number, today: string): { offset: number; lost: number }[] {
  const now = monthIndex(today.slice(0, 7));
  return months.map((m) => {
    const normal = m.incomeMinor - m.differenceMinor;
    const ratio = normal > 0 ? Math.min(1, Math.max(0, m.incomeMinor / normal)) : 1;
    return { offset: monthIndex(m.month) - now, lost: rate - Math.floor(rate * ratio) };
  });
}

function goalImpact(goal: ImpactGoal, months: readonly MonthComparison[], today: string): GoalImpact {
  const input = { ...goal, today };
  const before = forecastGoal(input);
  const losses = lostPerMonth(months, Math.max(0, goal.monthlyRateMinor), today);
  let after = before;
  let lostSavingMinor = 0;
  // Förseningen kan dra in fler ledighetsmånader före målet. Bortfallet växer bara, och högst till alla månader.
  for (;;) {
    const lost = losses.filter((l) => l.offset >= 1 && l.offset <= horizon(after)).reduce((sum, l) => sum + l.lost, 0);
    if (lost === lostSavingMinor) break;
    lostSavingMinor = lost;
    after = forecastGoal({ ...input, savedMinor: goal.savedMinor - lost });
  }
  // Bortfallet gör aldrig ett mål uppnått eller ouppnåeligt, så före och efter har samma slag.
  const monthsLater = after.kind === "eta" ? after.months - horizon(before) : null;
  return { id: goal.id, before, after, lostSavingMinor, monthsLater };
}

/** Underskott per berörd månad och sparmålens prognos före och efter ledigheten (KK-23-C). */
export function leaveImpact(input: LeaveImpactInput): LeaveImpact {
  const budgetMinor = assertMinor(input.monthlyBudgetMinor);
  return {
    months: input.months.map((m) => ({
      month: m.month,
      incomeMinor: m.incomeMinor,
      budgetMinor,
      shortfallMinor: Math.max(0, budgetMinor - m.incomeMinor),
    })),
    goals: input.goals.map((g) => goalImpact(g, input.months, input.today)),
  };
}
