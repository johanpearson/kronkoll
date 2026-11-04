/**
 * Uppskattad inkomst under föräldraledighet (KK-23-A, KK-23-B, beslut D-leave, flöde F-leave).
 *
 * dagbelopp = min(SGI, tak) × SGI-faktor × ersättningsnivå / 365, avrundat till hela kronor, där taket är
 * ett antal prisbasbelopp. Månaden = dagbelopp × uttagsdagar i månaden, plus föräldralön (procent av
 * SGI / 12 för andelen av månaden), minus skatt. Parametrarna kommer per år från `IncomeParameters` och
 * hårdkodas aldrig (antagande A-5). Ett manuellt nettobelopp per månad vinner alltid.
 *
 * Det här är en uppskattning, inte ett besked från Försäkringskassan. Alla belopp är heltal öre (D-money).
 */
import { addDays, addMonths, dateOf, weekday, yearMonthOf, type YearMonth } from "./calendar.ts";
import { assertMinor } from "./money.ts";

export interface IncomeParameters {
  readonly year: number;
  readonly priceBaseAmountMinor: number;
  /** Taket för SGI i antal prisbasbelopp, t.ex. 10. */
  readonly sgiCapMultiplier: number;
  /** Ersättningsnivån, t.ex. 0,80. */
  readonly benefitRate: number;
  /** Faktorn SGI räknas om med, t.ex. 0,97. */
  readonly sgiFactor: number;
}

export interface LeavePeriod {
  readonly from: string;
  readonly to: string;
  /** 0–7. Dagarna tas från måndag och framåt; en halv dag räknas som en halv. */
  readonly daysPerWeek: number;
  readonly sgiAnnualMinor: number;
  readonly employerTopupPct: number;
  readonly taxRatePct: number;
  /** Användarens eget nettobelopp per hel månad, eller null för uppskattningen (KK-23-B). */
  readonly overrideNetMonthlyMinor: number | null;
}

export interface LeaveMonth {
  /** ÅÅÅÅ-MM. */
  readonly month: string;
  /** Kalenderdagar i månaden som ligger i perioden. */
  readonly leaveDays: number;
  readonly daysInMonth: number;
  readonly withdrawalDays: number;
  readonly benefitGrossMinor: number;
  readonly topupGrossMinor: number;
  readonly netMinor: number;
  readonly source: "estimate" | "manual";
  /** Året vars parametrar användes, null för ett manuellt belopp. */
  readonly parametersYear: number | null;
  /** Sant om årets parametrar saknades och senaste årets användes. Visas som en varning. */
  readonly parametersFallback: boolean;
}

const YEAR_DAYS = 365;

/** Föräldrapenning per dag före skatt, avrundad till hela kronor. */
export function dailyBenefitMinor(sgiAnnualMinor: number, p: IncomeParameters): number {
  if (assertMinor(sgiAnnualMinor) < 0) throw new RangeError("SGI kan inte vara negativ");
  const sgi = Math.min(sgiAnnualMinor, p.priceBaseAmountMinor * p.sgiCapMultiplier);
  return Math.round((sgi * p.sgiFactor * p.benefitRate) / YEAR_DAYS / 100) * 100;
}

/** Årets parametrar, eller det senaste årets med `fallback` satt när året saknas. */
export function parametersFor(year: number, all: readonly IncomeParameters[]): { parameters: IncomeParameters; fallback: boolean } {
  const exact = all.find((p) => p.year === year);
  if (exact) return { parameters: exact, fallback: false };
  const latest = [...all].sort((a, b) => b.year - a.year)[0];
  if (!latest) throw new RangeError("Årsparametrar saknas");
  return { parameters: latest, fallback: true };
}

/** Uttagsdagar från och med `from` till och med `to`, med `daysPerWeek` dagar räknade från måndag. */
export function withdrawalDays(from: string, to: string, daysPerWeek: number): number {
  let days = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const fromMonday = (weekday(d) + 6) % 7;
    days += Math.min(1, Math.max(0, daysPerWeek - fromMonday));
  }
  return days;
}

const formatMonth = ({ year, month }: YearMonth) => `${String(year)}-${String(month).padStart(2, "0")}`;

function assertPct(pct: number): void {
  if (!(pct >= 0 && pct <= 100)) throw new RangeError("Procent ska vara 0–100");
}

function validate(period: LeavePeriod): void {
  if (period.to < period.from) throw new RangeError("Perioden slutar före den börjar");
  if (!(period.daysPerWeek >= 0 && period.daysPerWeek <= 7)) throw new RangeError("Dagar per vecka ska vara 0–7");
  assertPct(period.employerTopupPct);
  assertPct(period.taxRatePct);
  if (period.overrideNetMonthlyMinor !== null) assertMinor(period.overrideNetMonthlyMinor);
}

/** Uppskattad nettoinkomst för varje månad som perioden berör (KK-23-A), eller det manuella beloppet (KK-23-B). */
export function estimateLeaveIncome(period: LeavePeriod, parameters: readonly IncomeParameters[]): LeaveMonth[] {
  validate(period);
  const months: LeaveMonth[] = [];
  // "2027-08" sorteras före "2027-08-31", så månaden kan jämföras direkt med slutdatumet.
  for (let ym = yearMonthOf(period.from); formatMonth(ym) <= period.to; ym = addMonths(ym, 1)) {
    const daysInMonth = new Date(Date.UTC(ym.year, ym.month, 0)).getUTCDate();
    const first = [dateOf(ym.year, ym.month, 1), period.from].sort()[1] ?? period.from;
    const last = [dateOf(ym.year, ym.month, daysInMonth), period.to].sort()[0] ?? period.to;
    const leaveDays = Number(last.slice(8)) - Number(first.slice(8)) + 1;
    const share = leaveDays / daysInMonth;
    const days = withdrawalDays(first, last, period.daysPerWeek);
    const base = { month: formatMonth(ym), leaveDays, daysInMonth, withdrawalDays: days };

    if (period.overrideNetMonthlyMinor !== null) {
      const netMinor = Math.round(period.overrideNetMonthlyMinor * share);
      months.push({ ...base, benefitGrossMinor: 0, topupGrossMinor: 0, netMinor, source: "manual", parametersYear: null, parametersFallback: false });
      continue;
    }
    const { parameters: year, fallback } = parametersFor(ym.year, parameters);
    const benefitGrossMinor = Math.round(dailyBenefitMinor(period.sgiAnnualMinor, year) * days);
    const topupGrossMinor = Math.round(((period.sgiAnnualMinor / 12) * period.employerTopupPct * share) / 100);
    const netMinor = Math.round((benefitGrossMinor + topupGrossMinor) * (1 - period.taxRatePct / 100));
    months.push({ ...base, benefitGrossMinor, topupGrossMinor, netMinor, source: "estimate", parametersYear: year.year, parametersFallback: fallback });
  }
  return months;
}

export interface MonthComparison {
  readonly month: string;
  /** Ledighetens netto plus lön för månadens dagar utanför perioden. */
  readonly incomeMinor: number;
  /** Mot en normal månad; negativt när inkomsten är lägre. */
  readonly differenceMinor: number;
}

/** Inkomsten varje berörd månad jämfört med en normal månads nettolön (KK-23-A). */
export function compareWithNormal(months: readonly LeaveMonth[], normalNetMonthlyMinor: number): MonthComparison[] {
  assertMinor(normalNetMonthlyMinor);
  return months.map((m) => {
    const salaryMinor = Math.round((normalNetMonthlyMinor * (m.daysInMonth - m.leaveDays)) / m.daysInMonth);
    const incomeMinor = m.netMinor + salaryMinor;
    return { month: m.month, incomeMinor, differenceMinor: incomeMinor - normalNetMonthlyMinor };
  });
}
