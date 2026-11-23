import { describe, expect, it } from "vitest";
import { budgetExport, type ExportCategory } from "./budget-export.ts";

const kr = (amount: number) => amount * 100;
const category = (name: string, extra: Partial<ExportCategory> = {}): ExportCategory => ({
  name,
  budgetMinor: null,
  averageMinor: kr(1_000),
  normalMinor: kr(900),
  savingMinor: kr(700),
  actualMinor: kr(500),
  ...extra,
});

describe("budgetExport: rader för Excel och delbar sida (KK-43-A)", () => {
  it("i sparläge är riktlinjen sparlägesnivån, med kvar och andel", () => {
    const { rows } = budgetExport("saving", [category("Mat", { actualMinor: kr(350) })]);
    expect(rows).toEqual([{ name: "Mat", budgetMinor: null, averageMinor: kr(1_000), normalMinor: kr(900), savingMinor: kr(700), levelMinor: kr(700), actualMinor: kr(350), remainingMinor: kr(350), percent: 50, over: false }]);
  });

  it("utan sparläge finns ingen sparlägesnivå, och budget är riktlinjen där den är satt, annars normalt", () => {
    const [withBudget, without] = budgetExport("budget", [category("Mat", { budgetMinor: kr(800) }), category("Nöje")]).rows;
    expect(withBudget).toMatchObject({ savingMinor: null, levelMinor: kr(800), remainingMinor: kr(300) });
    expect(without).toMatchObject({ savingMinor: null, levelMinor: kr(900), remainingMinor: kr(400) });
    expect(budgetExport("none", [category("Mat", { budgetMinor: kr(800) })]).rows[0]).toMatchObject({ levelMinor: kr(900) });
  });

  it("över riktlinjen är kvar negativt och andelen över 100", () => {
    const [row] = budgetExport("saving", [category("Mat", { actualMinor: kr(1_050) })]).rows;
    expect(row).toMatchObject({ remainingMinor: -kr(350), percent: 150, over: true });
  });

  it("en riktlinje på noll ger ingen andel, och över bara om något är spenderat", () => {
    const [spent, unspent] = budgetExport("saving", [category("A", { savingMinor: 0, actualMinor: 1 }), category("B", { savingMinor: 0, actualMinor: 0 })]).rows;
    expect(spent).toMatchObject({ levelMinor: 0, percent: null, over: true });
    expect(unspent).toMatchObject({ percent: null, over: false });
  });

  it("rader sorteras på namn på svenska, och summorna räknar alla rader", () => {
    const { rows, totals } = budgetExport("saving", [category("Öl"), category("Mat"), category("Åkeri"), category("Barn", { budgetMinor: kr(100) })]);
    expect(rows.map((r) => r.name)).toEqual(["Barn", "Mat", "Åkeri", "Öl"]);
    expect(totals).toEqual({ name: "Summa", budgetMinor: kr(100), averageMinor: kr(4_000), normalMinor: kr(3_600), savingMinor: kr(2_800), levelMinor: kr(2_800), actualMinor: kr(2_000), remainingMinor: kr(800), percent: 71, over: false });
  });

  it("summan har ingen budget, sparlägesnivå eller riktlinje när ingen rad har någon", () => {
    const { totals } = budgetExport("none", [category("Mat")]);
    expect(totals).toMatchObject({ budgetMinor: null, savingMinor: null, levelMinor: kr(900) });
    expect(budgetExport("budget", []).totals).toMatchObject({ budgetMinor: null, savingMinor: null, levelMinor: 0, remainingMinor: 0, percent: null, over: false, actualMinor: 0 });
  });

  it.each(["budgetMinor", "averageMinor", "normalMinor", "savingMinor", "actualMinor"] as const)("avvisar %s som inte är heltal öre", (field) => {
    expect(() => budgetExport("saving", [category("Mat", { [field]: 1.5 })])).toThrow("Belopp måste vara ett heltal i öre");
  });
});
