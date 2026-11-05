// Ett lån som vyn och formuläret delar (#72, KK-36), tolkat från API:ts svar.
import { field } from "../api.ts";

export interface Loan {
  readonly id: string;
  readonly name: string;
  readonly lender: string | null;
  readonly balanceMinor: number;
  readonly interestRateBp: number;
  readonly rateFixedUntil: string | null;
  readonly amortizationMinor: number;
  readonly interestMinor: number;
  readonly costMinor: number;
  readonly rateFixed: boolean;
  readonly daysLeft: number | null;
  readonly ending: boolean;
}

const int = (v: unknown) => (Number.isSafeInteger(v) ? (v as number) : 0);
const str = (v: unknown) => (typeof v === "string" ? v : null);

export function toLoan(raw: unknown): Loan | null {
  const id = str(field(raw, "id"));
  const name = str(field(raw, "name"));
  if (id === null || name === null) return null;
  const days = field(raw, "rate_fixed_days_left");
  return {
    id,
    name,
    lender: str(field(raw, "lender")),
    balanceMinor: int(field(raw, "balance_minor")),
    interestRateBp: int(field(raw, "interest_rate_bp")),
    rateFixedUntil: str(field(raw, "rate_fixed_until")),
    amortizationMinor: int(field(raw, "amortization_minor")),
    interestMinor: int(field(raw, "monthly_interest_minor")),
    costMinor: int(field(raw, "monthly_cost_minor")),
    rateFixed: field(raw, "rate_fixed") === true,
    daysLeft: Number.isSafeInteger(days) ? (days as number) : null,
    ending: field(raw, "rate_fixed_ending") === true,
  };
}


/** 350 som "3,50 %". */
export const formatRate = (bp: number) => `${(bp / 100).toFixed(2).replace(".", ",")} %`;
