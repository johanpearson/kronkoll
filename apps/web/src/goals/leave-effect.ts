// Hur planerad föräldraledighet påverkar ett sparmål (#39, KK-23-C). Räknas i API:t och läses ur
// GET /api/leave-periods, där varje period har en rad per sparmål i `impacts` (type "goal").
import { formatDateShort, formatSek } from "@kronkoll/domain";
import { field, getJson } from "../api.ts";
import { formatPeriod } from "./goals.ts";

export interface LeaveEffect {
  readonly from: string;
  readonly to: string;
  readonly lostSavingMinor: number;
  readonly delayMonths: number | null;
  readonly reachBefore: string | null;
  readonly reachAfter: string | null;
}

const str = (v: unknown) => (typeof v === "string" ? v : null);
const int = (v: unknown) => (Number.isSafeInteger(v) ? (v as number) : null);

/** Effekterna på ett mål från alla planerade perioder, i periodernas ordning. Tom lista om de inte går att hämta. */
export async function fetchLeaveEffects(goalId: string): Promise<LeaveEffect[]> {
  const { status, body } = await getJson("/api/leave-periods");
  const items = field(body, "items");
  if (status !== 200 || !Array.isArray(items)) return [];
  return items.flatMap((period) => {
    const from = str(field(period, "from"));
    const to = str(field(period, "to"));
    const impacts = field(period, "impacts");
    if (from === null || to === null || !Array.isArray(impacts)) return [];
    return impacts
      .filter((i) => field(i, "type") === "goal" && field(i, "goal_id") === goalId)
      .map((i) => ({
        from,
        to,
        lostSavingMinor: int(field(i, "lost_saving_minor")) ?? 0,
        delayMonths: int(field(i, "delay_months")),
        reachBefore: str(field(i, "reach_period_before")),
        reachAfter: str(field(i, "reach_period_after")),
      }));
  });
}

/** En mening om effekten, t.ex. "Med ledighet 1 mars 2027 – 31 aug. 2027 nås målet mars 2028, 3 mån senare." */
export function effectText(e: LeaveEffect): string {
  const leave = `Med ledighet ${formatDateShort(e.from)} – ${formatDateShort(e.to)}`;
  const lost = e.lostSavingMinor > 0 ? ` Det blir ${formatSek(e.lostSavingMinor)} mindre sparat.` : "";
  if (e.reachAfter === null) return e.reachBefore === null ? `${leave} påverkas inte målet.` : `${leave} nås målet inte i den takten.${lost}`;
  if (e.delayMonths === null || e.delayMonths <= 0) return `${leave} nås målet ändå ${formatPeriod(e.reachAfter)}.${lost}`;
  return `${leave} nås målet ${formatPeriod(e.reachAfter)}, ${String(e.delayMonths)} mån senare.${lost}`;
}
