// Gesterna som rena beslut (KK-63). Svep mellan flikar bestäms här, så att
// trösklarna kan testas utan pekskärm. Komponenterna mäter fingret och frågar den här modulen.
import { tabOf, type Tab } from "./stack.ts";

/** Menyns ordning (KK-63-A). */
const ORDER: readonly Tab[] = ["/", "/transaktioner", "/budget", "/lan", "/inkomst"];

/** Ett svep som börjar så här nära kanten lämnas åt systemets bakåtgest (Android, KK-63-B). */
export const EDGE_PX = 24;
/** Så långt fingret ska röra sig innan riktningen bestäms. */
const LOCK_PX = 10;
/** Ett svep byter flik om det är minst så här stor del av bredden, eller tillräckligt snabbt. */
const DISTANCE_SHARE = 0.3;
const MIN_FLICK_PX = 40;
const FLICK_PX_PER_MS = 0.5;


export type Direction = "next" | "prev";

/** Åt vilket håll fingret rör sig: vågrätt ("x"), lodrätt ("y") eller ännu inte bestämt. */
export function swipeAxis(dx: number, dy: number): "x" | "y" | null {
  if (Math.hypot(dx, dy) < LOCK_PX) return null;
  return Math.abs(dx) > Math.abs(dy) ? "x" : "y";
}

/** Om ett avslutat vågrätt svep byter flik, och åt vilket håll. Null betyder att vyn studsar tillbaka. */
export function swipeDecision(input: { dx: number; ms: number; startX: number; width: number }): Direction | null {
  const { dx, ms, startX, width } = input;
  if (startX < EDGE_PX || startX > width - EDGE_PX) return null;
  const far = Math.abs(dx) >= width * DISTANCE_SHARE;
  const flick = Math.abs(dx) >= MIN_FLICK_PX && Math.abs(dx) / Math.max(ms, 1) >= FLICK_PX_PER_MS;
  if (!far && !flick) return null;
  return dx < 0 ? "next" : "prev";
}

/** Fliken bredvid i menyn, eller null vid ändarna. */
export function neighbourTab(path: string, direction: Direction): Tab | null {
  const index = ORDER.indexOf(tabOf(path));
  const next = ORDER[index + (direction === "next" ? 1 : -1)];
  return next ?? null;
}
