/**
 * Rader för export av budget och riktlinjer (KK-43-A) till Excel och en delbar sida. Ren logik: belopp
 * är heltal öre och formateras av den som visar dem. Banktexter (motparter) ingår aldrig, bara
 * kategorinamn och summor.
 */
import { sumMinor } from "./money.ts";

export type ExportMode = "none" | "budget" | "saving";

export interface ExportCategory {
  readonly name: string;
  /** Budget för kategorin, eller null när ingen är satt. */
  readonly budgetMinor: number | null;
  readonly averageMinor: number;
  readonly normalMinor: number;
  readonly savingMinor: number;
  readonly actualMinor: number;
}

export interface ExportRow {
  readonly name: string;
  readonly budgetMinor: number | null;
  readonly averageMinor: number;
  readonly normalMinor: number;
  /** Sparlägesnivån, bara i sparläge. */
  readonly savingMinor: number | null;
  /** Riktlinjen som utfallet mäts mot. */
  readonly levelMinor: number;
  readonly actualMinor: number;
  readonly remainingMinor: number;
  /** Utfallet i procent av riktlinjen, avrundat, eller null när riktlinjen är noll. */
  readonly percent: number | null;
  readonly over: boolean;
}

export interface BudgetExport {
  readonly rows: readonly ExportRow[];
  readonly totals: ExportRow;
}

/**
 * Riktlinjen: sparlägesnivån i sparläge, budgeten där den är satt i läget budget, annars normalnivån.
 * Utan budget (läget ingen budget) är det bara riktlinjer, så en satt budget räknas inte.
 */
function levelOf(mode: ExportMode, c: ExportCategory): number {
  if (mode === "saving") return c.savingMinor;
  return mode === "budget" ? (c.budgetMinor ?? c.normalMinor) : c.normalMinor;
}

function figures(name: string, parts: Omit<ExportRow, "name" | "remainingMinor" | "percent" | "over">): ExportRow {
  const { levelMinor, actualMinor } = parts;
  return {
    name,
    ...parts,
    remainingMinor: levelMinor - actualMinor,
    percent: levelMinor <= 0 ? null : Math.round((actualMinor * 100) / levelMinor),
    over: actualMinor > levelMinor,
  };
}

/** Summan av de belopp som finns, eller null när inget finns. */
const sumOrNull = (values: readonly (number | null)[]): number | null => {
  const present = values.filter((v): v is number => v !== null);
  return present.length === 0 ? null : sumMinor(present);
};

/** Raderna per kategori, sorterade på namn, och summan (KK-43-A). Summeringen avvisar belopp som inte är heltal öre. */
export function budgetExport(mode: ExportMode, categories: readonly ExportCategory[]): BudgetExport {
  const rows = [...categories]
    .sort((a, b) => a.name.localeCompare(b.name, "sv"))
    .map((c) =>
      figures(c.name, {
        budgetMinor: c.budgetMinor,
        averageMinor: c.averageMinor,
        normalMinor: c.normalMinor,
        savingMinor: mode === "saving" ? c.savingMinor : null,
        levelMinor: levelOf(mode, c),
        actualMinor: c.actualMinor,
      }),
    );
  const totals = figures("Summa", {
    budgetMinor: sumOrNull(rows.map((r) => r.budgetMinor)),
    averageMinor: sumMinor(rows.map((r) => r.averageMinor)),
    normalMinor: sumMinor(rows.map((r) => r.normalMinor)),
    savingMinor: sumOrNull(rows.map((r) => r.savingMinor)),
    levelMinor: sumMinor(rows.map((r) => r.levelMinor)),
    actualMinor: sumMinor(rows.map((r) => r.actualMinor)),
  });
  return { rows, totals };
}
