/**
 * Lån (KK-36, #72, beslut D-loans). Lånen läggs in för hand. Månadsräntan uppskattas som
 * skuld × ränta / 12, och månadskostnaden är räntan plus amorteringen. Lånebetalningarna delas inte
 * upp i budgeten; här räknas bara hur kostnaden fördelar sig, för lånvyn.
 *
 * Belopp är heltal öre (D-money). Räntan anges i hundradels procent: 350 = 3,50 %.
 */
import { daysBetween } from "./calendar.ts";
import { assertMinor, sumMinor } from "./money.ts";

/** En bindningstid som går ut inom så här många dagar markeras i lånvyn (KK-36-C). */
export const RATE_ENDING_DAYS = 60;

export interface Loan {
  readonly balanceMinor: number;
  readonly interestRateBp: number;
  readonly amortizationMinor: number;
  /** Sista dagen med bunden ränta, eller null för rörlig ränta. */
  readonly rateFixedUntil: string | null;
}

export interface LoanMonthly {
  readonly interestMinor: number;
  readonly amortizationMinor: number;
  readonly costMinor: number;
}

export function loanMonthly(loan: Loan): LoanMonthly {
  const balance = assertMinor(loan.balanceMinor);
  const amortization = assertMinor(loan.amortizationMinor);
  if (balance < 0) throw new RangeError("Skulden kan inte vara negativ");
  if (amortization < 0) throw new RangeError("Amorteringen kan inte vara negativ");
  if (!Number.isInteger(loan.interestRateBp) || loan.interestRateBp < 0 || loan.interestRateBp > 10_000) {
    throw new RangeError("Räntan måste vara mellan 0 och 100 %");
  }
  const interest = Math.round((balance * loan.interestRateBp) / (10_000 * 12));
  return { interestMinor: interest, amortizationMinor: amortization, costMinor: interest + amortization };
}

export function loanTotals(loans: readonly Loan[]): LoanMonthly & { readonly balanceMinor: number } {
  const monthly = loans.map(loanMonthly);
  return {
    balanceMinor: sumMinor(loans.map((l) => l.balanceMinor)),
    interestMinor: sumMinor(monthly.map((m) => m.interestMinor)),
    amortizationMinor: sumMinor(monthly.map((m) => m.amortizationMinor)),
    costMinor: sumMinor(monthly.map((m) => m.costMinor)),
  };
}

/** Om räntan är bunden i dag, hur många dagar som är kvar och om bindningstiden snart går ut. */
export function rateFixedStatus(loan: Loan, today: string): { fixed: boolean; daysLeft: number | null; ending: boolean } {
  if (loan.rateFixedUntil === null) return { fixed: false, daysLeft: null, ending: false };
  const daysLeft = daysBetween(today, loan.rateFixedUntil);
  if (daysLeft < 0) return { fixed: false, daysLeft: null, ending: false };
  return { fixed: true, daysLeft, ending: daysLeft <= RATE_ENDING_DAYS };
}
