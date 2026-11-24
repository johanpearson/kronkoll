// Riktlinjer och sparläge (KK-42): läser GET /api/guidelines. Svaret behandlas som okänd indata.
import { accountParams } from "../accounts/account-filter.tsx";
import { field, getJson } from "../api.ts";
import { toPeriod, type Period } from "../transactions/TransactionsView.tsx";

export type Mode = "none" | "budget" | "saving";

export interface GuidelineCategory {
  readonly categoryId: string;
  readonly averageMinor: number;
  readonly normalMinor: number;
  readonly fixedMinor: number;
  readonly savingMinor: number;
  /** Manuell nivå, eller null när nivån är beräknad. */
  readonly overrideMinor: number | null;
  readonly actualMinor: number;
  /** Förra periodens utfall. */
  readonly lastMinor: number;
  readonly overPace: boolean;
}

export interface Guidelines {
  readonly period: Period;
  readonly mode: Mode;
  readonly savingGoalMinor: number;
  /** Periodnycklar markerade som engångsperioder. */
  readonly oneOffPeriods: readonly string[];
  readonly expectedIncomeMinor: number;
  readonly fixedMinor: number;
  readonly feasible: boolean;
  readonly shortfallMinor: number;
  readonly freeMinor: number;
  readonly remainingMinor: number;
  readonly perDayMinor: number;
  readonly categories: readonly GuidelineCategory[];
}

const minor = (value: unknown) => (Number.isSafeInteger(value) ? (value as number) : 0);
const maybe = (value: unknown) => (Number.isSafeInteger(value) ? (value as number) : null);
const list = (value: unknown) => (Array.isArray(value) ? (value as unknown[]) : []);

function toCategory(raw: unknown): GuidelineCategory | null {
  const categoryId = field(raw, "category_id");
  if (typeof categoryId !== "string") return null;
  return {
    categoryId,
    averageMinor: minor(field(raw, "average_minor")),
    normalMinor: minor(field(raw, "normal_minor")),
    fixedMinor: minor(field(raw, "fixed_minor")),
    savingMinor: minor(field(raw, "saving_minor")),
    overrideMinor: maybe(field(raw, "override_minor")),
    actualMinor: minor(field(raw, "actual_minor")),
    lastMinor: minor(field(raw, "last_minor")),
    overPace: field(raw, "over_pace") === true,
  };
}

export async function fetchGuidelines(key: string, accountIds: readonly string[] = []): Promise<Guidelines | null> {
  const query = [`period=${encodeURIComponent(key)}`, accountParams(accountIds)].filter((q) => q !== "").join("&");
  const { status, body } = await getJson(`/api/guidelines?${query}`);
  const period = toPeriod(field(body, "period"));
  const mode = field(body, "mode");
  if (status !== 200 || !period || (mode !== "none" && mode !== "budget" && mode !== "saving") || !Array.isArray(field(body, "categories"))) return null;
  return {
    period,
    mode,
    savingGoalMinor: minor(field(body, "saving_goal_minor")),
    oneOffPeriods: list(field(body, "one_off_periods")).filter((p): p is string => typeof p === "string"),
    expectedIncomeMinor: minor(field(body, "expected_income_minor")),
    fixedMinor: minor(field(body, "fixed_minor")),
    feasible: field(body, "feasible") !== false,
    shortfallMinor: minor(field(body, "shortfall_minor")),
    freeMinor: minor(field(body, "free_to_spend_minor")),
    remainingMinor: minor(field(body, "remaining_free_minor")),
    perDayMinor: minor(field(body, "per_day_minor")),
    categories: list(field(body, "categories")).map(toCategory).filter((c): c is GuidelineCategory => c !== null),
  };
}
