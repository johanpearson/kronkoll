// GET /api/transactions (#32, KK-9, KK-18, KK-34): transaktionerna i en budgetperiod för listvyn. Dolda (KK-49)
// visas bara med ?hidden=true och ?status=booked|pending ger bara bokförda eller preliminära. GET /api/transactions/pending
// ger alla preliminära med summa, för gruppen Preliminärt (KK-56-A). POST /api/transactions/hide döljer eller visar flera på en gång.
// Perioden följer startdagen i inställningarna (t.ex. lönedagen) och svensk tid. Bankens text
// skickas som den kom och renderas alltid som text i appen (KK-30).
import { ruleRepository, settingsRepository, splitRepository, transactionRepository, type TransactionListItem } from "@kronkoll/adapter-d1";
import { budgetPeriodForKey, currentBudgetPeriod, explainCategory, ruleKey, sumMinor, type BudgetPeriod } from "@kronkoll/domain";
import { readAccountFilter } from "./account-filter.ts";
import { recomputeTransfers } from "./transfers.ts";
import type { SyncDeps } from "./sync.ts";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_QUERY_LENGTH = 100;
const MAX_ID_LENGTH = 64;
const MAX_CURSOR_LENGTH = 200;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

const invalid = () => json({ error: "invalid_request" }, 400);

function toJson(item: TransactionListItem) {
  return {
    id: item.id,
    account_id: item.accountId,
    status: item.status,
    transaction_date: item.transactionDate,
    booking_date: item.bookingDate,
    amount_minor: item.amountMinor,
    counterparty: item.counterparty,
    description: item.description,
    category_id: item.categoryId,
    category_source: item.categorySource,
    is_internal_transfer: item.isInternalTransfer,
    // Hur transaktionen rör en buffert, t.ex. saving_withdrawal för Uttag från sparande (KK-55-A). Null annars.
    kind: item.savingKind,
    manual_transfer: item.manualTransfer,
    split: item.split,
    hidden: item.hidden,
  };
}

/** Frågan ur adressen, eller null om något värde är ogiltigt. */
function readQuery(url: URL) {
  const params = url.searchParams;
  const limitText = params.get("limit");
  const limit = limitText === null ? DEFAULT_LIMIT : Number(limitText);
  const uncategorized = params.get("uncategorized");
  const hidden = params.get("hidden");
  const q = params.get("q") ?? undefined;
  const categoryId = params.get("category_id") ?? undefined;
  const cursor = params.get("cursor");
  const statusText = params.get("status");
  const status: "booked" | "pending" | undefined = statusText === "booked" || statusText === "pending" ? statusText : undefined;
  const accountIds = readAccountFilter(url);
  const valid =
    accountIds !== null &&
    Number.isInteger(limit) &&
    limit >= 1 &&
    limit <= MAX_LIMIT &&
    (uncategorized === null || uncategorized === "true" || uncategorized === "false") &&
    (hidden === null || hidden === "true" || hidden === "false") &&
    (statusText === null || status !== undefined) &&
    (q === undefined || q.length <= MAX_QUERY_LENGTH) &&
    (categoryId === undefined || (categoryId !== "" && categoryId.length <= MAX_ID_LENGTH)) &&
    (cursor === null || cursor.length <= MAX_CURSOR_LENGTH);
  return valid
    ? { period: params.get("period"), limit, uncategorized: uncategorized === "true", hidden: hidden === "true", status, q, categoryId, cursor, accountIds }
    : null;
}

export async function listTransactions(request: Request, env: { DB: D1Database }, sync: SyncDeps): Promise<Response> {
  const query = readQuery(new URL(request.url));
  if (!query) return invalid();

  let startDay: number;
  try {
    startDay = (await settingsRepository(env.DB).get()).budgetPeriodStartDay;
  } catch {
    return json({ error: "unavailable" }, 503);
  }

  let period: BudgetPeriod;
  try {
    period = query.period === null ? currentBudgetPeriod(sync.clock, startDay) : budgetPeriodForKey(query.period, startDay);
  } catch {
    return invalid();
  }

  try {
    const { items, nextCursor } = await transactionRepository(env.DB).list({
      from: period.start,
      to: period.end,
      limit: query.limit,
      uncategorized: query.uncategorized,
      hidden: query.hidden,
      status: query.status,
      q: query.q,
      categoryId: query.categoryId,
      accountIds: query.accountIds,
      cursor: query.cursor,
    });
    return json({ period, items: items.map(toJson), next_cursor: nextCursor }, 200);
  } catch (error) {
    return error instanceof RangeError ? invalid() : json({ error: "unavailable" }, 503);
  }
}

/**
 * GET /api/transactions/pending (KK-56-A): alla preliminära som inte är dolda, oavsett period, med summa och antal.
 * Följer kontofiltret. Fler än MAX_LIMIT preliminära samtidigt förekommer inte i praktiken, så det blir en sida.
 */
export async function listPending(request: Request, env: { DB: D1Database }): Promise<Response> {
  const accountIds = readAccountFilter(new URL(request.url));
  if (accountIds === null) return invalid();
  try {
    const { items } = await transactionRepository(env.DB).list({ status: "pending", limit: MAX_LIMIT, accountIds });
    return json({ items: items.map(toJson), total_minor: sumMinor(items.map((i) => i.amountMinor)), count: items.length }, 200);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}

/** GET /api/transactions/{id}: allt om en transaktion för detaljsidan (#32). */
export async function getTransaction(env: { DB: D1Database }, id: string): Promise<Response> {
  try {
    const detail = await transactionRepository(env.DB).detail(id);
    if (!detail) return json({ error: "not_found" }, 404);
    const [splits, rules] = await Promise.all([splitRepository(env.DB).get(id), ruleRepository(env.DB).list()]);
    const reason = explainCategory(detail, rules);
    const ruleItem = (ruleId: string) => {
      const r = rules.find((x) => x.id === ruleId);
      return r && { id: r.id, match: r.match, pattern: r.pattern, category_id: r.categoryId, source: r.source };
    };
    return json(
      {
        id: detail.id,
        account: { id: detail.accountId, name: detail.accountName, type: detail.accountType },
        status: detail.status,
        transaction_date: detail.transactionDate,
        booking_date: detail.bookingDate,
        amount_minor: detail.amountMinor,
        counterparty: detail.counterparty,
        // Det reglerna matchar på, även när banken inte skickar någon motpart.
        counterparty_norm: ruleKey(detail),
        description: detail.description,
        category_id: detail.categoryId,
        category_source: detail.categorySource,
        is_internal_transfer: detail.isInternalTransfer,
        kind: detail.savingKind,
        manual_transfer: detail.manualTransfer,
        income_type: detail.incomeType,
        income_source: detail.incomeSource,
        transfer_pair: detail.transferPair && {
          id: detail.transferPair.id,
          account_name: detail.transferPair.accountName,
          amount_minor: detail.transferPair.amountMinor,
          transaction_date: detail.transferPair.transactionDate,
        },
        splits: splits.map((p) => ({ category_id: p.categoryId, amount_minor: p.amountMinor })),
        // Varför fick den här kategorin? (KK-58-D): regeln som gav den, och andra som också träffar i vinstordning.
        category_reason: {
          source: reason.source,
          rule: reason.ruleId === null ? null : ruleItem(reason.ruleId),
          also_matched: reason.alsoMatched.flatMap((ruleId) => ruleItem(ruleId) ?? []),
        },
      },
      200,
    );
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}

/** Så många transaktioner går att dölja eller visa i ett anrop. */
export const MAX_HIDE = 100;

/**
 * POST /api/transactions/hide (KK-49): `{ ids, hidden }` döljer eller visar flera transaktioner. Dolda syns inte i
 * listan och räknas inte i budget, översikt, insikter eller inkomst, och att visa dem igen ångrar det. Ett eget
 * val (Räknas inte) rörs inte. Svarar med hur många som ändrades. Okända och borttagna id hoppas över.
 */
export async function hideTransactions(request: Request, env: { DB: D1Database }): Promise<Response> {
  const input: unknown = await request.json().catch(() => null);
  if (typeof input !== "object" || input === null) return invalid();
  const { ids, hidden } = input as Record<string, unknown>;
  const valid =
    typeof hidden === "boolean" &&
    Array.isArray(ids) &&
    ids.length >= 1 &&
    ids.length <= MAX_HIDE &&
    ids.every((id): id is string => typeof id === "string" && id !== "" && id.length <= MAX_ID_LENGTH) &&
    new Set(ids).size === ids.length;
  if (!valid) return invalid();
  try {
    const updated = await transactionRepository(env.DB).setHidden(ids, hidden);
    // Dolda räknas inte, så överföringar och Räkna inte-regler räknas om direkt.
    await recomputeTransfers(env.DB);
    return json({ updated, hidden }, 200);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}
