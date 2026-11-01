/**
 * Fabrik för syntetisk testdata (KK-13-B). All data är påhittad och deterministisk
 * (samma frö ger samma data). Riktig bankdata får aldrig användas i tester.
 */

export const FICTIONAL_COUNTERPARTIES = [
  "Fiktiva Livs AB",
  "Testbolaget Café",
  "Exempelbiografen",
  "Påhittade Pendeln",
  "Demo Bygg & Järn",
  "Låtsasmobil",
  "Prov Arbetsgivare AB",
  "Fiktiva Försäkringskassan",
] as const;

export type FictionalCounterparty = (typeof FICTIONAL_COUNTERPARTIES)[number];

export interface SyntheticTransaction {
  readonly id: string;
  readonly accountId: string;
  readonly date: string;
  readonly amountMinor: number;
  readonly counterparty: FictionalCounterparty;
  readonly description: string;
  readonly status: "pending" | "booked";
}

export interface SyntheticOptions {
  readonly seed: number;
  readonly from?: string;
  readonly days?: number;
  readonly accountId?: string;
}

/** Deterministisk slumptalsgenerator (mulberry32) som ger tal i [0, 1). */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)] as T;
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function syntheticTransaction(
  rng: () => number,
  index: number,
  overrides: Partial<SyntheticTransaction> = {},
  options: Omit<SyntheticOptions, "seed"> = {},
): SyntheticTransaction {
  const counterparty = pick(rng, FICTIONAL_COUNTERPARTIES);
  const isIncome = counterparty === "Prov Arbetsgivare AB" || counterparty === "Fiktiva Försäkringskassan";
  const magnitude = 100 + Math.floor(rng() * 500_000);
  return {
    id: `tx_fake_${String(index).padStart(5, "0")}`,
    accountId: options.accountId ?? "acc_fake_1",
    date: addDays(options.from ?? "2026-01-01", Math.floor(rng() * (options.days ?? 365))),
    amountMinor: isIncome ? magnitude : -magnitude,
    counterparty,
    description: `FIKTIV ${counterparty.toUpperCase()}`,
    status: rng() < 0.1 ? "pending" : "booked",
    ...overrides,
  };
}

export function syntheticTransactions(count: number, options: SyntheticOptions): SyntheticTransaction[] {
  const rng = createRng(options.seed);
  return Array.from({ length: count }, (_, i) => syntheticTransaction(rng, i, {}, options));
}
