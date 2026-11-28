// Lån (#72, KK-36): GET /api/loans, PUT /api/loans/{id} och DELETE /api/loans/{id}. Lånen läggs in för hand.
// Månadskostnad, fördelning på ränta och amortering och bindningstid räknas i domänen (loans.ts).
// Kontouppgifter (KK-59): POST /api/loans/preview visar vad texterna träffar, PUT /api/loans/{id}/matching sparar
// dem och kopplar hela historiken, och listan visar Betalt denna period. Texterna renderas alltid som text (KK-30).
import { categoryRepository, loanLinkRepository, loanRepository, settingsRepository, type LoanMatching, type LoanRecord } from "@kronkoll/adapter-d1";
import {
  currentBudgetPeriod,
  linkLoans,
  loanMatchPreview,
  loanMonthly,
  loanPaidInPeriod,
  loanTotals,
  rateFixedStatus,
  todayInStockholm,
  type LoanTransaction,
} from "@kronkoll/domain";
import type { SyncDeps } from "./sync.ts";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

const isDate = (value: unknown): value is string => typeof value === "string" && ISO_DATE.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().startsWith(value);
const isMinor = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isName = (value: unknown, min: number): value is string => typeof value === "string" && value.trim().length >= min && value.trim().length <= 60;

/** Kategorin som lånets betalningar får om användaren inte väljer någon (KK-59-A). Mallen saknar Boende › Lån. */
export const DEFAULT_LOAN_CATEGORY = "boende-laneranta";
const MAX_PATTERNS = 10;
const MAX_PATTERN_LENGTH = 60;

const NO_MATCHING = { patterns: [] as readonly string[], categoryId: null };

function view(loan: LoanRecord, today: string, matching: Pick<LoanMatching, "patterns" | "categoryId"> = NO_MATCHING) {
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
    match_patterns: matching.patterns,
    category_id: matching.categoryId,
  };
}

export async function listLoans(env: { DB: D1Database }, sync: SyncDeps): Promise<Response> {
  try {
    const links = loanLinkRepository(env.DB);
    const [loans, matchers, { budgetPeriodStartDay }] = await Promise.all([loanRepository(env.DB).list(), links.matchers(), settingsRepository(env.DB).get()]);
    const today = todayInStockholm(sync.clock);
    const period = currentBudgetPeriod(sync.clock, budgetPeriodStartDay);
    const payments = await links.payments(period.start, period.end);
    const matchingOf = new Map(matchers.map((m) => [m.loanId, m]));
    const totals = loanTotals(loans);
    return json(
      {
        loans: loans.map((l) => {
          const paid = loanPaidInPeriod({ loanId: l.id, transactions: payments, period, today });
          return { ...view(l, today, matchingOf.get(l.id)), paid: { paid_minor: paid.paidMinor, last_paid_on: paid.lastPaidOn, missing: paid.missing } };
        }),
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
    const matching = (await loanLinkRepository(env.DB).matchers()).find((m) => m.loanId === loan.id);
    return json(view(loan, todayInStockholm(sync.clock), matching), created ? 201 : 200);
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

/** Matchningstexterna ur begäran, eller null om de inte är en lista med högst tio texter på högst 60 tecken. */
function readPatterns(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_PATTERNS) return null;
  const patterns = value.map((p) => (typeof p === "string" ? p.trim() : null));
  return patterns.every((p): p is string => p !== null && p.length <= MAX_PATTERN_LENGTH) ? patterns.filter((p) => p !== "") : null;
}

const readBody = async (request: Request): Promise<Record<string, unknown> | null> => {
  const body: unknown = await request.json().catch(() => null);
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
};

const exampleJson = (tx: LoanTransaction) => ({ id: tx.id, date: tx.date, amount_minor: tx.amountMinor, counterparty: tx.counterparty, description: tx.description });

/** POST /api/loans/preview: hur många betalningar texterna träffar, med de senaste som exempel (KK-59-A). Sparar inget. */
export async function previewLoanMatch(request: Request, env: { DB: D1Database }): Promise<Response> {
  const body = await readBody(request);
  const patterns = body && readPatterns(body["match_patterns"]);
  if (!patterns) return json({ error: "invalid_request" }, 400);
  try {
    const preview = loanMatchPreview(await loanLinkRepository(env.DB).candidates(null), patterns);
    return json({ count: preview.count, examples: preview.examples.map(exampleJson) }, 200);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}

/**
 * PUT /api/loans/{id}/matching: sparar lånets texter och kategori och kopplar om hela historiken (KK-59-A, KK-59-B).
 * Utan `category_id` blir det Boende › Låneränta. `null` kopplar bara, utan att ändra kategorin.
 */
export async function putLoanMatching(request: Request, env: { DB: D1Database }, id: string): Promise<Response> {
  const body = await readBody(request);
  const patterns = body && readPatterns(body["match_patterns"]);
  const categoryId = body?.["category_id"] === undefined ? DEFAULT_LOAN_CATEGORY : body["category_id"];
  if (!patterns || (categoryId !== null && typeof categoryId !== "string")) return json({ error: "invalid_request" }, 400);
  try {
    if (categoryId !== null && !(await categoryRepository(env.DB).list()).some((c) => c.id === categoryId)) return json({ error: "invalid_request" }, 400);
    const repo = loanLinkRepository(env.DB);
    if (!(await repo.setMatching(id, patterns, categoryId))) return json({ error: "not_found" }, 404);
    const matching = await repo.matchers();
    const changes = linkLoans(await repo.candidates(null), matching);
    await repo.apply(changes, matching);
    return json({ match_patterns: patterns, category_id: categoryId, linked: changes.length }, 200);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}
