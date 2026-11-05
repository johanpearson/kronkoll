// GET /api/transactions (#32, KK-9, KK-18, KK-34): transaktionerna i en budgetperiod för listvyn.
// Perioden följer startdagen i inställningarna (t.ex. lönedagen) och svensk tid. Bankens text
// skickas som den kom och renderas alltid som text i appen (KK-30).
import { settingsRepository, splitRepository, transactionRepository, type TransactionListItem } from "@kronkoll/adapter-d1";
import { budgetPeriodForKey, currentBudgetPeriod, ruleKey, type BudgetPeriod } from "@kronkoll/domain";
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
    manual_transfer: item.manualTransfer,
    split: item.split,
  };
}

/** Frågan ur adressen, eller null om något värde är ogiltigt. */
function readQuery(url: URL) {
  const params = url.searchParams;
  const limitText = params.get("limit");
  const limit = limitText === null ? DEFAULT_LIMIT : Number(limitText);
  const uncategorized = params.get("uncategorized");
  const q = params.get("q") ?? undefined;
  const categoryId = params.get("category_id") ?? undefined;
  const cursor = params.get("cursor");
  const valid =
    Number.isInteger(limit) &&
    limit >= 1 &&
    limit <= MAX_LIMIT &&
    (uncategorized === null || uncategorized === "true" || uncategorized === "false") &&
    (q === undefined || q.length <= MAX_QUERY_LENGTH) &&
    (categoryId === undefined || (categoryId !== "" && categoryId.length <= MAX_ID_LENGTH)) &&
    (cursor === null || cursor.length <= MAX_CURSOR_LENGTH);
  return valid ? { period: params.get("period"), limit, uncategorized: uncategorized === "true", q, categoryId, cursor } : null;
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
      q: query.q,
      categoryId: query.categoryId,
      cursor: query.cursor,
    });
    return json({ period, items: items.map(toJson), next_cursor: nextCursor }, 200);
  } catch (error) {
    return error instanceof RangeError ? invalid() : json({ error: "unavailable" }, 503);
  }
}

/** GET /api/transactions/{id}: allt om en transaktion för detaljsidan (#32). */
export async function getTransaction(env: { DB: D1Database }, id: string): Promise<Response> {
  try {
    const detail = await transactionRepository(env.DB).detail(id);
    if (!detail) return json({ error: "not_found" }, 404);
    const splits = await splitRepository(env.DB).get(id);
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
      },
      200,
    );
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}
