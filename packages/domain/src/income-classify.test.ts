import { describe, expect, it } from "vitest";
import {
  INCOME_TEMPLATE_RULES,
  applyIncomeRules,
  classifyIncome,
  learnIncomeFromManualChoice,
  type IncomeRule,
  type IncomeTransaction,
} from "./income-classify.ts";

function tx(overrides: Partial<IncomeTransaction> & { id: string }): IncomeTransaction {
  return {
    amountMinor: 2_500_000,
    counterpartyNorm: "",
    description: "",
    incomeType: null,
    incomeSource: "none",
    ...overrides,
  };
}

const learnedAcme: IncomeRule = { id: "i-acme", match: "counterparty_prefix", pattern: "ACME AB", incomeType: "salary", source: "learned" };

function counter() {
  let n = 0;
  return () => `i-ny-${String(++n)}`;
}

describe("klassning av inkomster (KK-22-A, V-u-income)", () => {
  it("Försäkringskassan som motpart blir föräldrapenning", () => {
    expect(classifyIncome(tx({ id: "t1", counterpartyNorm: "FÖRSÄKRINGSKASSAN" }), INCOME_TEMPLATE_RULES)).toEqual({
      incomeType: "parental_benefit",
      source: "template",
      ruleId: "inkomst-forsakringskassan",
    });
  });

  it("känner igen Försäkringskassan utan å, ä och ö och i meddelandet när motpart saknas (Skandia)", () => {
    expect(classifyIncome(tx({ id: "t1", counterpartyNorm: "FORSAKRINGSKASSAN" }), INCOME_TEMPLATE_RULES)?.incomeType).toBe("parental_benefit");
    expect(classifyIncome(tx({ id: "t2", description: "Försäkringskassan, Stockholm" }), INCOME_TEMPLATE_RULES)?.ruleId).toBe(
      "inkomst-forsakringskassan",
    );
    expect(classifyIncome(tx({ id: "t3", description: "FORSAKRINGSKASSAN" }), INCOME_TEMPLATE_RULES)?.ruleId).toBe("inkomst-forsakringskassan-ascii");
  });

  it("\"LÖN ACME AB\" blir lön, även utan ö", () => {
    expect(classifyIncome(tx({ id: "t1", description: "LÖN ACME AB" }), INCOME_TEMPLATE_RULES)).toEqual({
      incomeType: "salary",
      source: "template",
      ruleId: "inkomst-lon",
    });
    expect(classifyIncome(tx({ id: "t2", counterpartyNorm: "LON ACME AB" }), INCOME_TEMPLATE_RULES)?.ruleId).toBe("inkomst-lon-ascii");
  });

  it("matchar hela ord: LÖNNEBERGA är inte lön", () => {
    expect(classifyIncome(tx({ id: "t1", counterpartyNorm: "LÖNNEBERGA BYGG" }), INCOME_TEMPLATE_RULES)?.incomeType).toBe("other");
  });

  it("en Swish som ingen regel känner igen blir övrigt", () => {
    expect(classifyIncome(tx({ id: "t1", counterpartyNorm: "SWISH FRÅN ANNA" }), INCOME_TEMPLATE_RULES)).toEqual({
      incomeType: "other",
      source: "none",
      ruleId: null,
    });
  });

  it("utbetalningar och nollbelopp är inga inkomster", () => {
    expect(classifyIncome(tx({ id: "t1", amountMinor: -100, counterpartyNorm: "FÖRSÄKRINGSKASSAN" }), INCOME_TEMPLATE_RULES)).toBeNull();
    expect(classifyIncome(tx({ id: "t2", amountMinor: 0, counterpartyNorm: "FÖRSÄKRINGSKASSAN" }), INCOME_TEMPLATE_RULES)).toBeNull();
  });

  it("ett belopp på 1 öre är en inkomst", () => {
    expect(classifyIncome(tx({ id: "t1", amountMinor: 1 }), [])?.incomeType).toBe("other");
  });

  it("lönen känns igen på arbetsgivarens namn genom en inlärd regel", () => {
    expect(classifyIncome(tx({ id: "t1", counterpartyNorm: "ACME AB" }), [...INCOME_TEMPLATE_RULES, learnedAcme])).toEqual({
      incomeType: "salary",
      source: "learned",
      ruleId: "i-acme",
    });
  });

  it("en inlärd regel vinner över en mallregel, även när mallregeln är exakt", () => {
    const learnedFk: IncomeRule = { id: "i-fk", match: "counterparty_prefix", pattern: "FÖRSÄKRINGSKASSAN", incomeType: "other", source: "learned" };
    const exactTemplate: IncomeRule = { id: "m-fk", match: "counterparty_exact", pattern: "FÖRSÄKRINGSKASSAN", incomeType: "parental_benefit", source: "template" };
    expect(classifyIncome(tx({ id: "t1", counterpartyNorm: "FÖRSÄKRINGSKASSAN" }), [exactTemplate, learnedFk])).toEqual({
      incomeType: "other",
      source: "learned",
      ruleId: "i-fk",
    });
  });

  it("en manuell klassning rörs aldrig", () => {
    const manual = tx({ id: "t1", counterpartyNorm: "FÖRSÄKRINGSKASSAN", incomeType: "salary", incomeSource: "manual" });
    expect(classifyIncome(manual, INCOME_TEMPLATE_RULES)).toEqual({ incomeType: "salary", source: "manual", ruleId: null });
  });

  it("en manuell markering utan inkomsttyp klassas med reglerna", () => {
    const broken = tx({ id: "t1", counterpartyNorm: "FÖRSÄKRINGSKASSAN", incomeSource: "manual" });
    expect(classifyIncome(broken, INCOME_TEMPLATE_RULES)?.incomeType).toBe("parental_benefit");
  });

  it("mallreglerna är mallregler och har unika id", () => {
    expect(INCOME_TEMPLATE_RULES.every((r) => r.source === "template")).toBe(true);
    expect(new Set(INCOME_TEMPLATE_RULES.map((r) => r.id)).size).toBe(INCOME_TEMPLATE_RULES.length);
    expect(INCOME_TEMPLATE_RULES.map((r) => `${r.match} ${r.pattern} ${r.incomeType}`)).toEqual([
      "counterparty_prefix FÖRSÄKRINGSKASSAN parental_benefit",
      "counterparty_prefix FORSAKRINGSKASSAN parental_benefit",
      "counterparty_prefix LÖN salary",
      "counterparty_prefix LON salary",
    ]);
  });
});

describe("manuell ändring lär en regel (KK-22-A)", () => {
  it("sätter klassningen som manuell och lär en regel på hela namnet", () => {
    const result = learnIncomeFromManualChoice({
      transaction: tx({ id: "t1", description: "ACME AB, STOCKHOLM" }),
      incomeType: "salary",
      rules: INCOME_TEMPLATE_RULES,
      newId: counter(),
    });
    expect(result.transaction).toMatchObject({ id: "t1", incomeType: "salary", incomeSource: "manual" });
    expect(result.rule).toEqual({ id: "i-ny-1", match: "counterparty_prefix", pattern: "ACME AB", incomeType: "salary", source: "learned" });
  });

  it("uppdaterar en befintlig inlärd regel för samma namn i stället för att skapa en ny", () => {
    const result = learnIncomeFromManualChoice({
      transaction: tx({ id: "t1", counterpartyNorm: "ACME AB" }),
      incomeType: "other",
      rules: [learnedAcme],
      newId: counter(),
    });
    expect(result.rule).toEqual({ ...learnedAcme, incomeType: "other" });
  });

  it("återanvänder inte en mallregel, en regel med annan matchning eller en inlärd regel för ett annat namn", () => {
    const exact: IncomeRule = { ...learnedAcme, id: "i-exakt", match: "counterparty_exact" };
    const template: IncomeRule = { ...learnedAcme, id: "m-acme", source: "template" };
    const other: IncomeRule = { ...learnedAcme, id: "i-annan", pattern: "ACME" };
    const result = learnIncomeFromManualChoice({
      transaction: tx({ id: "t1", counterpartyNorm: "ACME AB" }),
      incomeType: "salary",
      rules: [other, exact, template],
      newId: counter(),
    });
    expect(result.rule?.id).toBe("i-ny-1");
  });

  it("lär ingen regel när transaktionen saknar både motpart och meddelande", () => {
    const result = learnIncomeFromManualChoice({ transaction: tx({ id: "t1" }), incomeType: "other", rules: [], newId: counter() });
    expect(result.rule).toBeNull();
    expect(result.transaction).toMatchObject({ incomeType: "other", incomeSource: "manual" });
  });

  it("vägrar klassa en utbetalning eller ett nollbelopp som inkomst", () => {
    expect(() =>
      learnIncomeFromManualChoice({ transaction: tx({ id: "t1", amountMinor: -5 }), incomeType: "salary", rules: [], newId: counter() }),
    ).toThrow("Bara inbetalningar kan klassas som inkomst");
    expect(() =>
      learnIncomeFromManualChoice({ transaction: tx({ id: "t2", amountMinor: 0 }), incomeType: "salary", rules: [], newId: counter() }),
    ).toThrow("Bara inbetalningar kan klassas som inkomst");
  });

  it("den inlärda regeln klassar nästa lön från samma arbetsgivare", () => {
    const { rule } = learnIncomeFromManualChoice({
      transaction: tx({ id: "t1", counterpartyNorm: "ACME AB" }),
      incomeType: "salary",
      rules: [],
      newId: counter(),
    });
    expect(classifyIncome(tx({ id: "t2", counterpartyNorm: "ACME AB" }), rule ? [rule] : [])?.incomeType).toBe("salary");
  });
});

describe("applicera inkomstregler bakåt", () => {
  it("returnerar bara de transaktioner som ändras och hoppar över manuella och utbetalningar", () => {
    const transactions = [
      tx({ id: "ny-lon", counterpartyNorm: "ACME AB" }),
      tx({ id: "redan", counterpartyNorm: "FÖRSÄKRINGSKASSAN", incomeType: "parental_benefit", incomeSource: "template" }),
      tx({ id: "manuell", counterpartyNorm: "ACME AB", incomeType: "other", incomeSource: "manual" }),
      tx({ id: "utbetalning", amountMinor: -100, counterpartyNorm: "ACME AB" }),
      tx({ id: "kalla-andras", counterpartyNorm: "SWISH", incomeType: "other", incomeSource: "template" }),
    ];
    expect(applyIncomeRules(transactions, [...INCOME_TEMPLATE_RULES, learnedAcme])).toEqual([
      { id: "ny-lon", incomeType: "salary", incomeSource: "learned" },
      { id: "kalla-andras", incomeType: "other", incomeSource: "none" },
    ]);
  });

  it("nollställer en utbetalning som felaktigt har en inkomsttyp", () => {
    const wrong = tx({ id: "t1", amountMinor: -100, incomeType: "other", incomeSource: "none" });
    expect(applyIncomeRules([wrong], [])).toEqual([{ id: "t1", incomeType: null, incomeSource: "none" }]);
  });

  it("ändrar inget när klassningen redan stämmer", () => {
    expect(applyIncomeRules([tx({ id: "t1", incomeType: "other", incomeSource: "none" })], [])).toEqual([]);
  });
});
