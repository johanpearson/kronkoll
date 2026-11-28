// PUT /api/transactions/{id}/loan (KK-59-B): kopplar en betalning till ett lån för hand, eller tar bort kopplingen
// med `loan_id: null`. Kopplingen blir manuell och ändras aldrig av lånets matchningstexter. Tas den bort sätter
// reglerna kategorin direkt, så att betalningen inte blir okategoriserad till nästa synk.
import { loanLinkRepository, ruleRepository, transactionRepository } from "@kronkoll/adapter-d1";
import { applyRules } from "@kronkoll/domain";

const MAX_ID_LENGTH = 64;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

/** Lånets id ur begäran: en sträng, eller null för att ta bort kopplingen. Undefined om formen är fel. */
async function readLoanId(request: Request): Promise<string | null | undefined> {
  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== "object" || body === null || !("loan_id" in body)) return undefined;
  const loanId: unknown = body.loan_id;
  if (loanId === null) return null;
  return typeof loanId === "string" && loanId !== "" && loanId.length <= MAX_ID_LENGTH ? loanId : undefined;
}

export async function putTransactionLoan(request: Request, env: { DB: D1Database }, id: string): Promise<Response> {
  const loanId = await readLoanId(request);
  if (loanId === undefined) return json({ error: "invalid_request" }, 400);
  try {
    if (!(await loanLinkRepository(env.DB).setManual(id, loanId))) return json({ error: "not_found" }, 404);
    const store = transactionRepository(env.DB);
    if (loanId === null) {
      const tx = await store.get(id);
      if (tx) await store.setCategories(applyRules([tx], await ruleRepository(env.DB).list()));
    }
    const detail = await store.detail(id);
    if (!detail) return json({ error: "not_found" }, 404);
    return json({ loan: detail.loan, category_id: detail.categoryId, category_source: detail.categorySource }, 200);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}
