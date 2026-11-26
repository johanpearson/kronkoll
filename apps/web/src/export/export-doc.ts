// Innehållet i en export av budgeten (KK-43-A): en period och en rad per kategori. Samma dokument kan bli både Excel och en delbar PDF. Belopp ligger kvar i öre tills de visas, så
// att Excel får riktiga tal. Banktexter ingår inte, bara kategorinamn och summor.
import { budgetExport, formatDateShort } from "@kronkoll/domain";
import type { Guidelines } from "../guidelines/guidelines.ts";

/** En text, ett belopp i öre eller en andel i procent (null när den inte går att räkna). */
export type Cell = string | { readonly minor: number } | { readonly percent: number | null };

export interface ExportDoc {
  readonly title: string;
  /** Filnamnet utan ändelse. */
  readonly fileStem: string;
  readonly summary: readonly (readonly [string, Cell])[];
  readonly header: readonly string[];
  readonly rows: readonly (readonly Cell[])[];
  readonly totals: readonly Cell[];
  readonly note: string;
}

const money = (minor: number): Cell => ({ minor });

export function buildExportDoc(
  g: Guidelines,
  budgetLines: readonly { readonly categoryId: string; readonly budgetMinor: number | null }[],
  nameOf: (categoryId: string) => string,
): ExportDoc {
  const budgets = new Map(budgetLines.map((l) => [l.categoryId, l.budgetMinor]));
  const { rows, totals } = budgetExport(
    g.categories.map((c) => ({
      name: nameOf(c.categoryId),
      budgetMinor: budgets.get(c.categoryId) ?? null,
      averageMinor: c.averageMinor,
      normalMinor: c.normalMinor,
      actualMinor: c.actualMinor,
    })),
  );
  const cells = (r: (typeof rows)[number]): Cell[] => [
    r.name,
    r.budgetMinor === null ? "" : money(r.budgetMinor),
    money(r.normalMinor),
    money(r.actualMinor),
    money(r.remainingMinor),
    { percent: r.percent },
    r.over ? "Över" : "",
  ];
  const period = `${formatDateShort(g.period.start)} – ${formatDateShort(g.period.end)}`;
  return {
    title: `Budget ${period}`,
    fileStem: `kronkoll-budget-${g.period.key}`,
    summary: [
      ["Period", period],
    ],
    header: ["Kategori", "Budget", "Normalt", "Utfall", "Kvar", "Andel", "Status"],
    rows: rows.map(cells),
    totals: cells(totals),
    note: "Kvar, andel och status räknas mot budgeten där den är satt, annars normalnivån.",
  };
}
