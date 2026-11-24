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
  it("i sparläge har rapporten period, läge, nyckeltal och en rad per kategori med kvar, andel och status", () => {
    const doc = buildExportDoc(guidelines(), [{ categoryId: "mat", budgetMinor: 620000 }], names);
    expect(doc.title).toBe("Budget och riktlinjer 1 nov. 2026 – 30 nov. 2026");
    expect(doc.fileStem).toBe("kronkoll-budget-2026-11");
    expect(doc.summary).toEqual([
      ["Period", "1 nov. 2026 – 30 nov. 2026"],
      ["Läge", "Sparläge"],
      ["Sparmål per period", { minor: 800000 }],
      ["Förväntad inkomst", { minor: 4000000 }],
      ["Fasta kostnader", { minor: 900000 }],
      ["Fritt att spendera", { minor: 2300000 }],
      ["Kvar att spendera fritt", { minor: 1700000 }],
      ["Per dag resten av perioden", { minor: 106250 }],
    ]);
    expect(doc.header).toEqual(["Kategori", "Budget", "Normalt", "Sparläge", "Utfall", "Kvar", "Andel", "Status"]);
    expect(doc.rows).toEqual([
      ["Boende", "", { minor: 900000 }, { minor: 900000 }, { minor: 0 }, { minor: 900000 }, { percent: 0 }, ""],
      ["Mat", { minor: 620000 }, { minor: 615000 }, { minor: 600000 }, { minor: 650000 }, { minor: -50000 }, { percent: 108 }, "Över"],
    ]);
    expect(doc.totals).toEqual(["Summa", { minor: 620000 }, { minor: 1515000 }, { minor: 1500000 }, { minor: 650000 }, { minor: 850000 }, { percent: 43 }, ""]);
    expect(doc.note).toBe("Kvar, andel och status räknas mot sparläget.");
  });

  it("utan sparläge har rapporten ingen sparlägeskolumn och inga nyckeltal om utrymme", () => {
    const doc = buildExportDoc(guidelines({ mode: "none" }), [], names);
    expect(doc.header).toEqual(["Kategori", "Budget", "Normalt", "Utfall", "Kvar", "Andel", "Status"]);
    expect(doc.summary).toEqual([["Period", "1 nov. 2026 – 30 nov. 2026"], ["Läge", "Ingen budget – bara riktlinjer"]]);
    expect(doc.rows[1]).toEqual(["Mat", "", { minor: 615000 }, { minor: 650000 }, { minor: -35000 }, { percent: 106 }, "Över"]);
    expect(doc.note).toContain("normalnivån");
  });

  it("i läget budget räknas mot budgeten där den är satt", () => {
    const doc = buildExportDoc(guidelines({ mode: "budget" }), [{ categoryId: "mat", budgetMinor: 700000 }], names);
    expect(doc.rows[1]).toEqual(["Mat", { minor: 700000 }, { minor: 615000 }, { minor: 650000 }, { minor: 50000 }, { percent: 93 }, ""]);
    expect(doc.note).toBe("Kvar, andel och status räknas mot budgeten där den är satt, annars normalnivån.");
  });
});
