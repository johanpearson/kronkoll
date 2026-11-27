/**
 * Rader för export av budgeten (KK-43-A) till Excel och en delbar sida. Ren logik: belopp
 * är heltal öre och formateras av den som visar dem. Banktexter (motparter) ingår aldrig, bara
 * kategorinamn och summor.
 */
import { sumMinor } from "./money.ts";

export interface ExportCategory {
  readonly name: string;
  /** Budget för kategorin, eller null när ingen är satt. */
  readonly budgetMinor: number | null;
  readonly averageMinor: number;
  readonly normalMinor: number;
  readonly actualMinor: number;
}

export interface ExportRow {
  readonly name: string;
  readonly budgetMinor: number | null;
  readonly averageMinor: number;
  readonly normalMinor: number;
  /** Nivån som utfallet mäts mot: budgeten där den är satt, annars normalnivån. */
  readonly levelMinor: number;
  readonly actualMinor: number;
  readonly remainingMinor: number;
  /** Utfallet i procent av nivån, avrundat, eller null när nivån är noll. */
  readonly percent: number | null;
  readonly over: boolean;
}

export interface BudgetExport {
  readonly rows: readonly ExportRow[];
  readonly totals: ExportRow;
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
export function budgetExport(categories: readonly ExportCategory[]): BudgetExport {
  const rows = [...categories]
    .sort((a, b) => a.name.localeCompare(b.name, "sv"))
    .map((c) =>
      figures(c.name, {
        budgetMinor: c.budgetMinor,
        averageMinor: c.averageMinor,
        normalMinor: c.normalMinor,
        levelMinor: c.budgetMinor ?? c.normalMinor,
        actualMinor: c.actualMinor,
      }),
    );
  const totals = figures("Summa", {
    budgetMinor: sumOrNull(rows.map((r) => r.budgetMinor)),
    averageMinor: sumMinor(rows.map((r) => r.averageMinor)),
    normalMinor: sumMinor(rows.map((r) => r.normalMinor)),
    levelMinor: sumMinor(rows.map((r) => r.levelMinor)),
    actualMinor: sumMinor(rows.map((r) => r.actualMinor)),
  });
  return { rows, totals };
}
