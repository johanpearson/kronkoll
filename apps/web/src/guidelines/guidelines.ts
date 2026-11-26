// Underlag till budgetplaneraren (KK-42): läser GET /api/guidelines. Svaret behandlas som okänd indata.
import { accountParams } from "../accounts/account-filter.tsx";
import { field, getJson } from "../api.ts";
import { toPeriod, type Period } from "../transactions/TransactionsView.tsx";

export interface GuidelineCategory {
  readonly categoryId: string;
  readonly averageMinor: number;
  readonly normalMinor: number;
  readonly fixedMinor: number;
  readonly actualMinor: number;
  /** Förra periodens utfall. */
  readonly lastMinor: number;
}

export interface Guidelines {
  readonly period: Period;
  /** Periodnycklar markerade som engångsperioder. */
  readonly oneOffPeriods: readonly string[];
  readonly expectedIncomeMinor: number;
  readonly fixedMinor: number;
  readonly categories: readonly GuidelineCategory[];
}

const minor = (value: unknown) => (Number.isSafeInteger(value) ? (value as number) : 0);
const list = (value: unknown) => (Array.isArray(value) ? (value as unknown[]) : []);

function toCategory(raw: unknown): GuidelineCategory | null {
  const categoryId = field(raw, "category_id");
  if (typeof categoryId !== "string") return null;
  return {
    categoryId,
    averageMinor: minor(field(raw, "average_minor")),
    normalMinor: minor(field(raw, "normal_minor")),
    fixedMinor: minor(field(raw, "fixed_minor")),
    actualMinor: minor(field(raw, "actual_minor")),
    lastMinor: minor(field(raw, "last_minor")),
  };
}

export async function fetchGuidelines(key: string, accountIds: readonly string[] = []): Promise<Guidelines | null> {
  const query = [`period=${encodeURIComponent(key)}`, accountParams(accountIds)].filter((q) => q !== "").join("&");
  const { status, body } = await getJson(`/api/guidelines?${query}`);
  const period = toPeriod(field(body, "period"));
  if (status !== 200 || !period || !Array.isArray(field(body, "categories"))) return null;
  return {
    period,
    oneOffPeriods: list(field(body, "one_off_periods")).filter((p): p is string => typeof p === "string"),
    expectedIncomeMinor: minor(field(body, "expected_income_minor")),
    fixedMinor: minor(field(body, "fixed_minor")),
    categories: list(field(body, "categories")).map(toCategory).filter((c): c is GuidelineCategory => c !== null),
  };
}
