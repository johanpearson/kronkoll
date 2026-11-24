import { describe, expect, it } from "vitest";
import { budgetPlan } from "./budget-plan.ts";

const kr = (amount: number) => amount * 100;
const rows = (...amounts: number[]) => amounts.map((a, i) => ({ categoryId: `k${String(i)}`, plannedMinor: kr(a) }));

describe("budgetPlan: summering av en planerad budget (KK-42-C)", () => {
  it("40 000 + 5 000 i inkomst, 41 200 i utgifter och 3 000 i sparande ger 44 200 och 800 över", () => {
    const plan = budgetPlan({ incomesMinor: [kr(40_000), kr(5_000)], rows: rows(9_000, 30_000, 2_200), savingMinor: kr(3_000) });
    expect(plan).toMatchObject({ incomeMinor: kr(45_000), expensesMinor: kr(41_200), savingMinor: kr(3_000), totalMinor: kr(44_200), leftoverMinor: kr(800), deficit: false });
  });

  it("utgifter på 43 200 kr ger ett underskott på 1 200 kr", () => {
    const plan = budgetPlan({ incomesMinor: [kr(40_000), kr(5_000)], rows: rows(43_200), savingMinor: kr(3_000) });
    expect(plan).toMatchObject({ totalMinor: kr(46_200), leftoverMinor: -kr(1_200), deficit: true });
  });

  it("går det precis jämnt upp är det inget underskott", () => {
    const plan = budgetPlan({ incomesMinor: [kr(1_000)], rows: rows(900), savingMinor: kr(100) });
    expect(plan).toMatchObject({ leftoverMinor: 0, deficit: false });
  });

  it("varje rad får sin andel av inkomsten, avrundad, i samma ordning", () => {
    const plan = budgetPlan({ incomesMinor: [kr(30_000)], rows: rows(9_000, 6_100, 1), savingMinor: 0 });
    expect(plan.rows).toEqual([
      { categoryId: "k0", plannedMinor: kr(9_000), shareOfIncomePercent: 30 },
      { categoryId: "k1", plannedMinor: kr(6_100), shareOfIncomePercent: 20 },
      { categoryId: "k2", plannedMinor: kr(1), shareOfIncomePercent: 0 },
    ]);
  });

  it("utan inkomst finns ingen andel, och utgifterna blir ett underskott", () => {
    const plan = budgetPlan({ incomesMinor: [], rows: rows(500), savingMinor: 0 });
    expect(plan.rows[0]?.shareOfIncomePercent).toBeNull();
    expect(plan).toMatchObject({ incomeMinor: 0, leftoverMinor: -kr(500), deficit: true });
  });

  it("utan rader och sparande blir allt över", () => {
    expect(budgetPlan({ incomesMinor: [kr(100)], rows: [], savingMinor: 0 })).toMatchObject({ expensesMinor: 0, totalMinor: 0, leftoverMinor: kr(100), deficit: false, rows: [] });
  });

  it.each([
    ["inkomst", { incomesMinor: [-1], rows: [], savingMinor: 0 }],
    ["utgift", { incomesMinor: [], rows: [{ categoryId: "k", plannedMinor: -1 }], savingMinor: 0 }],
    ["sparande", { incomesMinor: [], rows: [], savingMinor: -1 }],
  ])("avvisar ett negativt belopp i %s", (_name, input) => {
    expect(() => budgetPlan(input)).toThrow("Belopp får inte vara negativa");
  });

  it.each([
    ["inkomst", { incomesMinor: [1.5], rows: [], savingMinor: 0 }],
    ["utgift", { incomesMinor: [], rows: [{ categoryId: "k", plannedMinor: 1.5 }], savingMinor: 0 }],
    ["sparande", { incomesMinor: [], rows: [], savingMinor: 1.5 }],
  ])("avvisar ett belopp som inte är heltal öre i %s", (_name, input) => {
    expect(() => budgetPlan(input)).toThrow("Belopp måste vara ett heltal i öre");
  });
});
