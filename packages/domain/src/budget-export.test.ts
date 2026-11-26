import { describe, expect, it } from "vitest";
import { budgetExport, type ExportCategory } from "./budget-export.ts";

const kr = (amount: number) => amount * 100;
const category = (name: string, extra: Partial<ExportCategory> = {}): ExportCategory => ({
  name,
  budgetMinor: null,
  averageMinor: kr(1_000),
  normalMinor: kr(900),
  actualMinor: kr(500),
  ...extra,
});

describe("budgetExport: rader för Excel och delbar sida (KK-43-A)", () => {
  it("budgeten är nivån där den är satt, annars normalnivån, med kvar och andel", () => {
    const [withBudget, without] = budgetExport([category("Mat", { budgetMinor: kr(800) }), category("Nöje")]).rows;
    expect(withBudget).toEqual({ name: "Mat", budgetMinor: kr(800), averageMinor: kr(1_000), normalMinor: kr(900), levelMinor: kr(800), actualMinor: kr(500), remainingMinor: kr(300), percent: 63, over: false });
    expect(without).toMatchObject({ budgetMinor: null, levelMinor: kr(900), remainingMinor: kr(400), percent: 56 });
  });

  it("över nivån är kvar negativt och andelen över 100", () => {
    const [row] = budgetExport([category("Mat", { actualMinor: kr(1_350) })]).rows;
    expect(row).toMatchObject({ remainingMinor: -kr(450), percent: 150, over: true });
  });

  it("en nivå på noll ger ingen andel, och över bara om något är spenderat", () => {
    const [spent, unspent] = budgetExport([category("A", { budgetMinor: 0, actualMinor: 1 }), category("B", { budgetMinor: 0, actualMinor: 0 })]).rows;
    expect(spent).toMatchObject({ levelMinor: 0, percent: null, over: true });
    expect(unspent).toMatchObject({ percent: null, over: false });
  });

  it("rader sorteras på namn på svenska, och summorna räknar alla rader", () => {
    const { rows, totals } = budgetExport([category("Öl"), category("Mat"), category("Åkeri"), category("Barn", { budgetMinor: kr(100) })]);
    expect(rows.map((r) => r.name)).toEqual(["Barn", "Mat", "Åkeri", "Öl"]);
    expect(totals).toEqual({ name: "Summa", budgetMinor: kr(100), averageMinor: kr(4_000), normalMinor: kr(3_600), levelMinor: kr(2_800), actualMinor: kr(2_000), remainingMinor: kr(800), percent: 71, over: false });
  });

  it("summan har ingen budget när ingen rad har någon", () => {
    expect(budgetExport([category("Mat")]).totals).toMatchObject({ budgetMinor: null, levelMinor: kr(900) });
    expect(budgetExport([]).totals).toMatchObject({ budgetMinor: null, levelMinor: 0, remainingMinor: 0, percent: null, over: false, actualMinor: 0 });
  });

  it.each(["budgetMinor", "averageMinor", "normalMinor", "actualMinor"] as const)("avvisar %s som inte är heltal öre", (field) => {
    expect(() => budgetExport([category("Mat", { [field]: 1.5 })])).toThrow("Belopp måste vara ett heltal i öre");
  });
});
