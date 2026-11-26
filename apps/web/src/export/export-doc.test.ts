import { describe, expect, it } from "vitest";
import type { Guidelines } from "../guidelines/guidelines.ts";
import { buildExportDoc } from "./export-doc.ts";

/** Påhittade riktlinjer (KK-13). */
const guidelines = (extra: Partial<Guidelines> = {}): Guidelines => ({
  period: { key: "2026-11", start: "2026-11-01", end: "2026-11-30" },
  mode: "saving",
  savingGoalMinor: 800000,
  oneOffPeriods: [],
  expectedIncomeMinor: 4000000,
  fixedMinor: 900000,
  feasible: true,
  shortfallMinor: 0,
  freeMinor: 2300000,
  remainingMinor: 1700000,
  perDayMinor: 106250,
  categories: [
    { categoryId: "mat", averageMinor: 613333, normalMinor: 615000, fixedMinor: 0, savingMinor: 600000, overrideMinor: null, actualMinor: 650000, lastMinor: 0, overPace: true },
    { categoryId: "boende", averageMinor: 900000, normalMinor: 900000, fixedMinor: 900000, savingMinor: 900000, overrideMinor: null, actualMinor: 0, lastMinor: 0, overPace: false },
  ],
  ...extra,
});
const names = (id: string) => ({ mat: "Mat", boende: "Boende" })[id] ?? id;

describe("buildExportDoc (KK-43-A)", () => {
  it("har period och en rad per kategori med budget, kvar, andel och status", () => {
    const doc = buildExportDoc(guidelines(), [{ categoryId: "mat", budgetMinor: 620000 }], names);
    expect(doc.title).toBe("Budget 1 nov. 2026 – 30 nov. 2026");
    expect(doc.fileStem).toBe("kronkoll-budget-2026-11");
    expect(doc.summary).toEqual([["Period", "1 nov. 2026 – 30 nov. 2026"]]);
    expect(doc.header).toEqual(["Kategori", "Budget", "Normalt", "Utfall", "Kvar", "Andel", "Status"]);
    expect(doc.rows).toEqual([
      ["Boende", "", { minor: 900000 }, { minor: 0 }, { minor: 900000 }, { percent: 0 }, ""],
      ["Mat", { minor: 620000 }, { minor: 615000 }, { minor: 650000 }, { minor: -30000 }, { percent: 105 }, "Över"],
    ]);
    expect(doc.totals).toEqual(["Summa", { minor: 620000 }, { minor: 1515000 }, { minor: 650000 }, { minor: 870000 }, { percent: 43 }, ""]);
    expect(doc.note).toBe("Kvar, andel och status räknas mot budgeten där den är satt, annars normalnivån.");
  });

  it("räknas mot normalnivån för en kategori utan budget", () => {
    const doc = buildExportDoc(guidelines(), [], names);
    expect(doc.rows[1]).toEqual(["Mat", "", { minor: 615000 }, { minor: 650000 }, { minor: -35000 }, { percent: 106 }, "Över"]);
  });
});
