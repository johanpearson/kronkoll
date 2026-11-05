/**
 * Återkommande dragningar (KK-24-A): samma motpart, liknande belopp och ett månatligt eller årligt
 * intervall. Serien byggs bakåt från den senaste dragningen, så ett nytt pris räknas från senaste
 * dragningen. En motpart som har andra köp inom serien, som en matbutik, räknas inte som återkommande.
 */
import { addMonths, daysBetween, dateOf, yearMonthOf } from "./calendar.ts";

export interface RecurringTransaction {
  readonly id: string;
  /** Bokföringsdag, annars köpdag. */
  readonly date: string;
  readonly amountMinor: number;
  /** Motparten som den visas. */
  readonly counterparty: string;
  /** Normaliserad motpart (domain/normalize) som serierna grupperas på. */
  readonly counterpartyNorm: string;
  readonly status: "pending" | "booked" | "removed";
  readonly internal: boolean;
}

export type RecurringInterval = "monthly" | "yearly";

export interface RecurringCharge {
  readonly counterparty: string;
  readonly counterpartyNorm: string;
  readonly interval: RecurringInterval;
  /** Senaste dragningens belopp, positivt i öre. */
  readonly amountMinor: number;
  readonly lastDate: string;
  readonly nextExpected: string;
  readonly yearlyMinor: number;
  readonly occurrences: number;
}

interface Rule {
  readonly interval: RecurringInterval;
  readonly minDays: number;
  readonly maxDays: number;
  readonly minOccurrences: number;
  /** En serie vars senaste dragning är äldre än så här har upphört. */
  readonly activeDays: number;
  readonly months: number;
  readonly perYear: number;
}

const RULES: readonly Rule[] = [
  { interval: "monthly", minDays: 25, maxDays: 35, minOccurrences: 3, activeDays: 45, months: 1, perYear: 12 },
  { interval: "yearly", minDays: 350, maxDays: 380, minOccurrences: 2, activeDays: 400, months: 12, perYear: 1 },
];

/** Högsta tillåtna skillnad mot senaste beloppet, i procent. */
export const AMOUNT_TOLERANCE_PCT = 20;

const similar = (amount: number, latest: number) => Math.abs(amount - latest) * 100 <= AMOUNT_TOLERANCE_PCT * latest;

function nextDate(date: string, months: number): string {
  const day = Number(date.slice(8, 10));
  const { year, month } = addMonths(yearMonthOf(date), months);
  const lastDay = Number(dateOf(year, month + 1, 0).slice(8, 10));
  return dateOf(year, month, Math.min(day, lastDay));
}

/** Kedjan av dragningar för en regel, äldst först, eller null om den inte håller. */
function chainFor(charges: readonly RecurringTransaction[], rule: Rule, today: string): RecurringTransaction[] | null {
  const latest = charges[charges.length - 1] as RecurringTransaction;
  if (daysBetween(latest.date, today) > rule.activeDays) return null;
  const chain = [latest];
  for (let i = charges.length - 2; i >= 0; i--) {
    const candidate = charges[i] as RecurringTransaction;
    const gap = daysBetween(candidate.date, (chain[0] as RecurringTransaction).date);
    if (gap > rule.maxDays) break;
    if (gap >= rule.minDays && similar(-candidate.amountMinor, -latest.amountMinor)) chain.unshift(candidate);
  }
  if (chain.length < rule.minOccurrences) return null;
  const first = (chain[0] as RecurringTransaction).date;
  return charges.filter((c) => c.date >= first).length === chain.length ? chain : null;
}

export function recurringCharges(transactions: readonly RecurringTransaction[], today: string): RecurringCharge[] {
  const groups = new Map<string, RecurringTransaction[]>();
  for (const tx of transactions) {
    if (tx.amountMinor >= 0 || tx.status === "removed" || tx.internal || tx.counterpartyNorm === "") continue;
    groups.set(tx.counterpartyNorm, [...(groups.get(tx.counterpartyNorm) ?? []), tx]);
  }
  const result: RecurringCharge[] = [];
  for (const [counterpartyNorm, list] of groups) {
    const charges = [...list].sort((a, b) => a.date.localeCompare(b.date));
    for (const rule of RULES) {
      const chain = chainFor(charges, rule, today);
      if (chain === null) continue;
      const latest = chain[chain.length - 1] as RecurringTransaction;
      const amountMinor = -latest.amountMinor;
      result.push({
        counterparty: latest.counterparty,
        counterpartyNorm,
        interval: rule.interval,
        amountMinor,
        lastDate: latest.date,
        nextExpected: nextDate(latest.date, rule.months),
        yearlyMinor: amountMinor * rule.perYear,
        occurrences: chain.length,
      });
      break;
    }
  }
  return result.sort((a, b) => b.yearlyMinor - a.yearlyMinor || a.counterparty.localeCompare(b.counterparty, "sv"));
}
