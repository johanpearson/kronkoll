// Sparmål i appen (#39, KK-21): läser GET /api/goals och gör om svaret till det vyerna visar.
// Prognosen räknas i API:t med domänen (forecastGoal); här bestäms bara texten.
import { field, getJson } from "../api.ts";

export type Forecast =
  | { readonly kind: "reached" }
  | { readonly kind: "never"; readonly requiredMonthlyMinor: number | null }
  | {
      readonly kind: "eta";
      readonly reachPeriod: string;
      readonly monthsLeft: number;
      readonly onTrack: boolean | null;
      readonly monthsLate: number | null;
      readonly requiredMonthlyMinor: number | null;
    };

export interface Goal {
  readonly id: string;
  readonly name: string;
  readonly targetMinor: number;
  readonly targetDate: string | null;
  readonly source: "manual" | "account";
  readonly accountMissing: boolean;
  readonly savedMinor: number;
  readonly monthlyRateMinor: number;
  readonly forecast: Forecast;
}

const int = (value: unknown) => (Number.isSafeInteger(value) ? (value as number) : 0);
const intOrNull = (value: unknown) => (Number.isSafeInteger(value) ? (value as number) : null);

function toForecast(raw: unknown): Forecast {
  const kind = field(raw, "kind");
  if (kind === "reached") return { kind };
  const required = intOrNull(field(raw, "required_monthly_minor"));
  const period = field(raw, "reach_period");
  if (kind !== "eta" || typeof period !== "string") return { kind: "never", requiredMonthlyMinor: required };
  const onTrack = field(raw, "on_track");
  return {
    kind,
    reachPeriod: period,
    monthsLeft: int(field(raw, "months_left")),
    onTrack: typeof onTrack === "boolean" ? onTrack : null,
    monthsLate: intOrNull(field(raw, "months_late")),
    requiredMonthlyMinor: required,
  };
}

export function toGoal(raw: unknown): Goal | null {
  const id = field(raw, "id");
  const name = field(raw, "name");
  if (typeof id !== "string" || typeof name !== "string") return null;
  const targetDate = field(raw, "target_date");
  return {
    id,
    name,
    targetMinor: int(field(raw, "target_minor")),
    targetDate: typeof targetDate === "string" ? targetDate : null,
    source: field(raw, "source") === "account" ? "account" : "manual",
    accountMissing: field(raw, "account_missing") === true,
    savedMinor: int(field(raw, "saved_minor")),
    monthlyRateMinor: int(field(raw, "monthly_rate_minor")),
    forecast: toForecast(field(raw, "forecast")),
  };
}

/** Alla sparmål, eller null om de inte går att hämta. */
export async function fetchGoals(): Promise<Goal[] | null> {
  const { status, body } = await getJson("/api/goals");
  const items = field(body, "items");
  if (status !== 200 || !Array.isArray(items)) return null;
  return items.map(toGoal).filter((g): g is Goal => g !== null);
}

const MONTH = new Intl.DateTimeFormat("sv-SE", { month: "short", year: "numeric", timeZone: "UTC" });

/** "2027-12" som "dec. 2027". */
export const formatPeriod = (period: string) => MONTH.format(new Date(`${period}-01T00:00:00Z`));

/** Status som en kort etikett. Texten bär betydelsen; färgen förstärker. */
export function goalBadge(goal: Goal): { text: string; tone: "ok" | "warn" | "bad" } | null {
  if (goal.accountMissing) return { text: "Kopplat konto saknas", tone: "bad" };
  const f = goal.forecast;
  if (f.kind === "reached") return { text: "Nått", tone: "ok" };
  if (f.kind === "never") return { text: "Nås inte i nuvarande takt", tone: "bad" };
  if (f.onTrack === true) return { text: "I fas", tone: "ok" };
  if (f.monthsLate !== null && f.monthsLate > 0) return { text: `${String(f.monthsLate)} mån sen`, tone: "warn" };
  return null;
}
