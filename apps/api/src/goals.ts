// Sparmål (#39, KK-21): GET och POST /api/goals, GET /api/goals/{id} och POST /api/goals/{id}/contributions.
// Prognosen räknas i domänen (forecastGoal) med takten de senaste 3 månaderna: manuella avsättningar,
// eller rörelserna på det kopplade kontot. Ett mål vars konto har försvunnit visas med account_missing.
import { goalRepository, type Contribution, type GoalChanges, type GoalRecord, type NewGoal } from "@kronkoll/adapter-d1";
import { addDays, averageMonthlySaving, forecastGoal, todayInStockholm, type GoalForecast } from "@kronkoll/domain";
import type { SyncDeps } from "./sync.ts";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
/** Rörelser hämtas lite längre bakåt än 3 månader. Domänen väljer exakt vilka som räknas. */
const MOVEMENT_DAYS = 100;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

const invalid = () => json({ error: "invalid_request" }, 400);
const isDate = (value: unknown): value is string => typeof value === "string" && ISO_DATE.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().startsWith(value);
const isMinor = (value: unknown, min: number): value is number => Number.isSafeInteger(value) && (value as number) >= min;

function forecastBody(f: GoalForecast) {
  if (f.kind === "reached") return { kind: f.kind, remaining_minor: 0 };
  if (f.kind === "never") return { kind: f.kind, remaining_minor: f.remainingMinor, required_monthly_minor: f.requiredPerMonthMinor };
  return {
    kind: f.kind,
    remaining_minor: f.remainingMinor,
    months_left: f.months,
    reach_period: f.reachedIn,
    on_track: f.onTrack,
    months_late: f.monthsLate,
    required_monthly_minor: f.requiredPerMonthMinor,
  };
}

export interface GoalStatus {
  readonly savedMinor: number;
  readonly monthlyRateMinor: number;
  readonly accountMissing: boolean;
  /** Avsättningarna för manuella mål, nyast först. Tom för mål som bygger på ett konto. */
  readonly contributions: readonly Contribution[];
}

/**
 * Sparat och takt för ett mål: underlaget till prognosen. Används av sparmålen och av ledighetens påverkan
 * (KK-23-C), så att siffrorna alltid är desamma.
 */
export async function goalStatus(db: D1Database, goal: GoalRecord, today: string): Promise<GoalStatus> {
  const repo = goalRepository(db);
  if (goal.source === "manual") {
    const contributions = await repo.contributions(goal.id);
    const savedMinor = goal.initialMinor + contributions.reduce((sum, c) => sum + c.amountMinor, 0);
    return { savedMinor, monthlyRateMinor: averageMonthlySaving(contributions, today), accountMissing: false, contributions };
  }
  const account = goal.accountId === null ? null : await repo.account(goal.accountId, addDays(today, -MOVEMENT_DAYS));
  return {
    savedMinor: Math.max(0, account?.balanceMinor ?? 0),
    monthlyRateMinor: averageMonthlySaving(account?.movements ?? [], today),
    accountMissing: account === null,
    contributions: [],
  };
}

/** Sparat, takt och prognos för ett mål, plus avsättningarna för manuella mål. */
async function view(db: D1Database, goal: GoalRecord, today: string) {
  const { savedMinor: saved, monthlyRateMinor: rate, accountMissing, contributions } = await goalStatus(db, goal, today);
  return {
    id: goal.id,
    name: goal.name,
    target_minor: goal.targetMinor,
    target_date: goal.targetDate,
    source: goal.source,
    account_id: goal.accountId,
    account_missing: accountMissing,
    saved_minor: saved,
    monthly_rate_minor: rate,
    forecast: forecastBody(forecastGoal({ targetMinor: goal.targetMinor, savedMinor: saved, monthlyRateMinor: rate, targetDate: goal.targetDate, today })),
    contributions: contributions.map((c) => ({ id: c.id, date: c.date, amount_minor: c.amountMinor })),
  };
}

export async function listGoals(env: { DB: D1Database }, sync: SyncDeps): Promise<Response> {
  try {
    const today = todayInStockholm(sync.clock);
    const goals = await goalRepository(env.DB).list();
    return json({ items: await Promise.all(goals.map((g) => view(env.DB, g, today))) }, 200);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}

export async function getGoal(env: { DB: D1Database }, id: string, sync: SyncDeps): Promise<Response> {
  try {
    const goal = await goalRepository(env.DB).get(id);
    if (!goal) return json({ error: "not_found" }, 404);
    return json(await view(env.DB, goal, todayInStockholm(sync.clock)), 200);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}

/** Målet ur begäran, eller null om formen är fel. */
async function readGoal(request: Request): Promise<NewGoal | null> {
  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== "object" || body === null) return null;
  const { name, target_minor: target, target_date: targetDate = null, source } = body as Record<string, unknown>;
  if (typeof name !== "string" || name.trim().length < 1 || name.trim().length > 60) return null;
  if (!isMinor(target, 1) || (targetDate !== null && !isDate(targetDate))) return null;
  if (typeof source !== "object" || source === null) return null;
  const { type, initial_minor: initial = 0, account_id: accountId } = source as Record<string, unknown>;
  if (type === "manual" && isMinor(initial, 0)) return { name: name.trim(), targetMinor: target, targetDate, source: "manual", accountId: null, initialMinor: initial };
  if (type === "account" && typeof accountId === "string" && accountId !== "") return { name: name.trim(), targetMinor: target, targetDate, source: "account", accountId, initialMinor: 0 };
  return null;
}

export async function createGoal(request: Request, env: { DB: D1Database }, sync: SyncDeps): Promise<Response> {
  const goal = await readGoal(request);
  if (!goal) return invalid();
  const today = todayInStockholm(sync.clock);
  if (goal.targetDate !== null && goal.targetDate <= today) return json({ error: "target_date_in_past" }, 422);
  try {
    const repo = goalRepository(env.DB);
    if (goal.accountId !== null && (await repo.account(goal.accountId, today)) === null) return json({ error: "unknown_account" }, 400);
    const id = sync.newId();
    await repo.create(goal, id);
    return json(await view(env.DB, { id, ...goal }, today), 201);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}

/** Ändringarna ur en PATCH, eller null om formen är fel eller inget ändras. */
async function readChanges(request: Request): Promise<GoalChanges | null> {
  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== "object" || body === null) return null;
  const raw = body as Record<string, unknown>;
  const changes: { -readonly [K in keyof GoalChanges]: GoalChanges[K] } = {};
  if ("name" in raw) {
    if (typeof raw["name"] !== "string" || raw["name"].trim().length < 1 || raw["name"].trim().length > 60) return null;
    changes.name = raw["name"].trim();
  }
  if ("target_minor" in raw) {
    if (!isMinor(raw["target_minor"], 1)) return null;
    changes.targetMinor = raw["target_minor"];
  }
  if ("target_date" in raw) {
    if (raw["target_date"] !== null && !isDate(raw["target_date"])) return null;
    changes.targetDate = raw["target_date"];
  }
  if ("initial_minor" in raw) {
    if (!isMinor(raw["initial_minor"], 0)) return null;
    changes.initialMinor = raw["initial_minor"];
  }
  return Object.keys(changes).length > 0 ? changes : null;
}

/** PATCH /api/goals/{id} (KK-21-C): ändrar målet och ger det med ny prognos. Källa och konto går inte att byta. */
export async function patchGoal(request: Request, env: { DB: D1Database }, id: string, sync: SyncDeps): Promise<Response> {
  const changes = await readChanges(request);
  if (!changes) return invalid();
  const today = todayInStockholm(sync.clock);
  if (changes.targetDate != null && changes.targetDate <= today) return json({ error: "target_date_in_past" }, 422);
  try {
    const repo = goalRepository(env.DB);
    const goal = await repo.get(id);
    if (!goal) return json({ error: "not_found" }, 404);
    if (changes.initialMinor !== undefined && goal.source !== "manual") return json({ error: "goal_uses_account" }, 409);
    await repo.update(id, changes);
    return json(await view(env.DB, { ...goal, ...changes }, today), 200);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}

/** DELETE /api/goals/{id} (KK-21-C): tar bort målet och dess avsättningar. Inget hos banken ändras. */
export async function deleteGoal(env: { DB: D1Database }, id: string): Promise<Response> {
  try {
    return (await goalRepository(env.DB).remove(id)) ? new Response(null, { status: 204 }) : json({ error: "not_found" }, 404);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}

/** DELETE /api/goals/{id}/contributions/{contributionId} (KK-21-C). */
export async function deleteContribution(env: { DB: D1Database }, goalId: string, contributionId: string): Promise<Response> {
  try {
    return (await goalRepository(env.DB).removeContribution(goalId, contributionId)) ? new Response(null, { status: 204 }) : json({ error: "not_found" }, 404);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}

/** POST /api/goals/{id}/contributions: en avsättning, eller ett uttag med negativt belopp. Datum är i dag om inget anges. */
export async function addContribution(request: Request, env: { DB: D1Database }, goalId: string, sync: SyncDeps): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== "object" || body === null) return invalid();
  const today = todayInStockholm(sync.clock);
  const { amount_minor: amount, date = today } = body as Record<string, unknown>;
  if (!Number.isSafeInteger(amount) || amount === 0 || !isDate(date) || date > today) return invalid();
  try {
    const repo = goalRepository(env.DB);
    const goal = await repo.get(goalId);
    if (!goal) return json({ error: "not_found" }, 404);
    if (goal.source !== "manual") return json({ error: "goal_uses_account" }, 409);
    await repo.addContribution(goalId, { date, amountMinor: amount as number }, sync.newId());
    return json(await view(env.DB, goal, today), 201);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}
