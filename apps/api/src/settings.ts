// Inställningar (#34, KK-34): GET och PATCH /api/settings. Just nu dagen budgetperioden börjar, 1–28,
// där 1 är kalendermånaden och t.ex. 25 är lönedagen. Svaret har också perioden som pågår med den
// startdagen, så att appen kan visa vad valet betyder.
import { settingsRepository } from "@kronkoll/adapter-d1";
import { currentBudgetPeriod } from "@kronkoll/domain";
import type { SyncDeps } from "./sync.ts";

const MAX_START_DAY = 28;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

const view = (startDay: number, sync: SyncDeps) => ({ budget_period_start_day: startDay, current_period: currentBudgetPeriod(sync.clock, startDay) });

export async function getSettings(env: { DB: D1Database }, sync: SyncDeps): Promise<Response> {
  try {
    return json(view((await settingsRepository(env.DB).get()).budgetPeriodStartDay, sync), 200);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}

/** Startdagen ur begäran, eller null om den saknas eller inte är ett heltal 1–28. */
async function readStartDay(request: Request): Promise<number | null> {
  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== "object" || body === null || !("budget_period_start_day" in body)) return null;
  const day = body.budget_period_start_day;
  return Number.isInteger(day) && (day as number) >= 1 && (day as number) <= MAX_START_DAY ? (day as number) : null;
}

export async function patchSettings(request: Request, env: { DB: D1Database }, sync: SyncDeps): Promise<Response> {
  const day = await readStartDay(request);
  if (day === null) return json({ error: "invalid_request" }, 400);
  try {
    await settingsRepository(env.DB).setBudgetPeriodStartDay(day);
    return json(view(day, sync), 200);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}
