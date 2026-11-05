// Lån (#72, KK-36): GET /api/loans, PUT /api/loans/{id} och DELETE /api/loans/{id}. Lånen läggs in för hand.
// Månadskostnad, fördelning på ränta och amortering och bindningstid räknas i domänen (loans.ts).
import { loanRepository, type LoanRecord } from "@kronkoll/adapter-d1";
import { loanMonthly, loanTotals, rateFixedStatus, todayInStockholm } from "@kronkoll/domain";
import type { SyncDeps } from "./sync.ts";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

const isDate = (value: unknown): value is string => typeof value === "string" && ISO_DATE.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().startsWith(value);
const isMinor = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isName = (value: unknown, min: number): value is string => typeof value === "string" && value.trim().length >= min && value.trim().length <= 60;

function view(loan: LoanRecord, today: string) {
  const monthly = loanMonthly(loan);
  const rate = rateFixedStatus(loan, today);
  return {
    id: loan.id,
    name: loan.name,
    lender: loan.lender,
    balance_minor: loan.balanceMinor,
    interest_rate_bp: loan.interestRateBp,
    rate_fixed_until: loan.rateFixedUntil,
    amortization_minor: loan.amortizationMinor,
    monthly_interest_minor: monthly.interestMinor,
    monthly_amortization_minor: monthly.amortizationMinor,
    monthly_cost_minor: monthly.costMinor,
    rate_fixed: rate.fixed,
    rate_fixed_days_left: rate.daysLeft,
    rate_fixed_ending: rate.ending,
  };
}

export async function listLoans(env: { DB: D1Database }, sync: SyncDeps): Promise<Response> {
  try {
    const loans = await loanRepository(env.DB).list();
    const today = todayInStockholm(sync.clock);
    const totals = loanTotals(loans);
    return json(
      {
        loans: loans.map((l) => view(l, today)),
        total_balance_minor: totals.balanceMinor,
        total_monthly_interest_minor: totals.interestMinor,
        total_monthly_amortization_minor: totals.amortizationMinor,
        total_monthly_cost_minor: totals.costMinor,
      },
      200,
    );
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}

/** Lånet ur begäran, eller null om formen är fel. */
async function readLoan(request: Request, id: string): Promise<LoanRecord | null> {
  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  const { name, lender = null, balance_minor: balance, interest_rate_bp: rate, rate_fixed_until: fixed = null, amortization_minor: amortization } = b;
  if (!isName(name, 1) || (lender !== null && !isName(lender, 0))) return null;
  if (!isMinor(balance) || !isMinor(amortization) || !Number.isInteger(rate) || (rate as number) < 0 || (rate as number) > 10_000) return null;
  if (fixed !== null && !isDate(fixed)) return null;
  const trimmedLender = lender === null ? null : lender.trim();
  return {
    id,
    name: name.trim(),
    lender: trimmedLender === "" ? null : trimmedLender,
    balanceMinor: balance,
    interestRateBp: rate as number,
    rateFixedUntil: fixed,
    amortizationMinor: amortization,
  };
}

/** PUT: lägger till lånet med det id appen valt, eller ändrar det. 201 för ett nytt lån, 200 för ett ändrat. */
export async function putLoan(request: Request, env: { DB: D1Database }, id: string, sync: SyncDeps): Promise<Response> {
  const loan = await readLoan(request, id);
  if (!loan) return json({ error: "invalid_request" }, 400);
  try {
    const created = await loanRepository(env.DB).save(loan);
    return json(view(loan, todayInStockholm(sync.clock)), created ? 201 : 200);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}

export async function deleteLoan(env: { DB: D1Database }, id: string): Promise<Response> {
  try {
    return (await loanRepository(env.DB).remove(id)) ? new Response(null, { status: 204 }) : json({ error: "not_found" }, 404);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}
