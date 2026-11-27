// Periodens sparade budget och utfall per huvudkategori: GET /api/budgets/{period}. Svaret behandlas som okänd indata.
import { accountParams } from "../accounts/account-filter.tsx";
import { field, getJson } from "../api.ts";
import { toPeriod, type Period } from "../transactions/TransactionsView.tsx";

export interface Figures {
  readonly categoryId: string;
  readonly budgetMinor: number | null;
  readonly actualMinor: number;
  readonly remainingMinor: number | null;
  readonly percent: number | null;
  readonly over: boolean;
}

export interface Group extends Figures {
  readonly subcategories: readonly Figures[];
}

export interface Budget {
  readonly period: Period;
  /** Budgetraderna som de är sparade, för redigeringen. */
  readonly lines: readonly { readonly categoryId: string; readonly budgetMinor: number }[];
  readonly groups: readonly Group[];
  readonly uncategorizedMinor: number;
  readonly totalBudgetMinor: number;
  readonly totalActualMinor: number;
  readonly excludedInternalMinor: number;
}

const minor = (value: unknown) => (Number.isSafeInteger(value) ? (value as number) : 0);
const maybe = (value: unknown) => (Number.isSafeInteger(value) ? (value as number) : null);
const list = (value: unknown) => (Array.isArray(value) ? (value as unknown[]) : []);

function toFigures(raw: unknown): Figures | null {
  const categoryId = field(raw, "category_id");
  if (typeof categoryId !== "string") return null;
  return {
    categoryId,
    budgetMinor: maybe(field(raw, "budget_minor")),
    actualMinor: minor(field(raw, "actual_minor")),
    remainingMinor: maybe(field(raw, "remaining_minor")),
    percent: maybe(field(raw, "percent")),
    over: field(raw, "over") === true,
  };
}

export async function fetchBudget(key: string, accountIds: readonly string[] = []): Promise<Budget | null> {
  const query = accountParams(accountIds);
  const { status, body } = await getJson(`/api/budgets/${encodeURIComponent(key)}${query === "" ? "" : `?${query}`}`);
  const period = toPeriod(field(body, "period"));
  if (status !== 200 || !period || !Array.isArray(field(body, "groups"))) return null;
  return {
    period,
    lines: list(field(body, "lines")).flatMap((raw) => {
      const f = toFigures(raw);
      return f && f.budgetMinor !== null ? [{ categoryId: f.categoryId, budgetMinor: f.budgetMinor }] : [];
    }),
    groups: list(field(body, "groups")).flatMap((raw): Group[] => {
      const f = toFigures(raw);
      return f ? [{ ...f, subcategories: list(field(raw, "subcategories")).map(toFigures).filter((s): s is Figures => s !== null) }] : [];
    }),
    uncategorizedMinor: minor(field(body, "uncategorized_minor")),
    totalBudgetMinor: minor(field(body, "total_budget_minor")),
    totalActualMinor: minor(field(body, "total_actual_minor")),
    excludedInternalMinor: minor(field(body, "excluded_internal_minor")),
  };
}
