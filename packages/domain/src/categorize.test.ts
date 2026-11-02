import { describe, expect, it } from "vitest";
import {
  applyRules,
  ruleReach,
  categorize,
  learnFromManualChoice,
  type CategorizableTransaction,
  type CategoryRule,
} from "./categorize.ts";

function tx(overrides: Partial<CategorizableTransaction> & { id: string }): CategorizableTransaction {
  return {
    counterpartyNorm: "ICA NARA SOFO",
    description: "",
    categoryId: null,
    categorySource: "none",
    ...overrides,
  };
}

const templateIca: CategoryRule = {
  id: "r-mall-ica",
  match: "counterparty_prefix",
  pattern: "ICA",
  categoryId: "mat",
  source: "template",
};

function counter() {
  let n = 0;
  return () => `r-ny-${String(++n)}`;
}

describe("kategorisering med regler (KK-18)", () => {
  it("en mallregel kategoriserar en okategoriserad transaktion", () => {
    expect(categorize(tx({ id: "t1" }), [templateIca])).toEqual({ categoryId: "mat", source: "template", ruleId: "r-mall-ica" });
  });

  it("matchar på ordprefix: ICA matchar ICA KVANTUM men inte ICAROS", () => {
    expect(categorize(tx({ id: "t1", counterpartyNorm: "ICA KVANTUM" }), [templateIca])?.categoryId).toBe("mat");
    expect(categorize(tx({ id: "t1", counterpartyNorm: "ICAROS" }), [templateIca])).toBeNull();
  });

  it("ger null när ingen regel matchar", () => {
    expect(categorize(tx({ id: "t1", counterpartyNorm: "OKÄND" }), [templateIca])).toBeNull();
  });

  it("inlärd regel vinner över mall (prioritet manuell > inlärd > mall)", () => {
    const learned: CategoryRule = { ...templateIca, id: "r-lärd", categoryId: "hushåll", source: "learned" };
    expect(categorize(tx({ id: "t1" }), [templateIca, learned])?.ruleId).toBe("r-lärd");
  });

  it("inom samma källa vinner exakt matchning, sedan längre mönster", () => {
    const short: CategoryRule = { ...templateIca, id: "kort", pattern: "ICA", categoryId: "a" };
    const long: CategoryRule = { ...templateIca, id: "lång", pattern: "ICA NARA", categoryId: "b" };
    const exact: CategoryRule = { ...templateIca, id: "exakt", match: "counterparty_exact", pattern: "ICA NARA SOFO", categoryId: "c" };
    expect(categorize(tx({ id: "t1" }), [short, long])?.ruleId).toBe("lång");
    expect(categorize(tx({ id: "t1" }), [short, long, exact])?.ruleId).toBe("exakt");
  });

  it("kan matcha på beskrivning när motparten saknas", () => {
    const rule: CategoryRule = { id: "r-hyra", match: "description_contains", pattern: "HYRA", categoryId: "boende", source: "template" };
    expect(categorize(tx({ id: "t1", counterpartyNorm: "", description: "Hyra november" }), [rule])?.categoryId).toBe("boende");
  });

  it("tomma mönster matchar aldrig", () => {
    const empty: CategoryRule[] = [
      { id: "e1", match: "counterparty_exact", pattern: "", categoryId: "x", source: "template" },
      { id: "e2", match: "description_contains", pattern: "", categoryId: "x", source: "template" },
    ];
    expect(categorize(tx({ id: "t1", counterpartyNorm: "", description: "" }), empty)).toBeNull();
  });

  it("vid lika prioritet avgör regelns id, så resultatet är stabilt", () => {
    const a: CategoryRule = { ...templateIca, id: "a", categoryId: "x" };
    const b: CategoryRule = { ...templateIca, id: "b", categoryId: "y" };
    expect(categorize(tx({ id: "t1" }), [b, a])?.ruleId).toBe("a");
  });

  it("en manuellt satt kategori skrivs aldrig över (KK-18-C)", () => {
    expect(categorize(tx({ id: "t1", categoryId: "egen", categorySource: "manual" }), [templateIca])).toEqual({
      categoryId: "egen",
      source: "manual",
      ruleId: null,
    });
  });
});

describe("inlärning: \"Gör alltid så\" (KK-18-B)", () => {
  it("markerar transaktionen som manuell och skapar en inlärd regel på normaliserad motpart", () => {
    const result = learnFromManualChoice({
      transaction: tx({ id: "t1" }),
      categoryId: "livsmedel",
      alwaysDoThis: true,
      rules: [],
      newId: counter(),
    });
    expect(result.transaction).toMatchObject({ categoryId: "livsmedel", categorySource: "manual" });
    expect(result.rule).toEqual({
      id: "r-ny-1",
      match: "counterparty_prefix",
      pattern: "ICA NARA SOFO",
      categoryId: "livsmedel",
      source: "learned",
    });
  });

  it("framtida köp hos samma motpart kategoriseras sedan automatiskt, men inte andra motparter med samma första ord", () => {
    const { rule } = learnFromManualChoice({ transaction: tx({ id: "t1" }), categoryId: "livsmedel", alwaysDoThis: true, rules: [], newId: counter() });
    const rules = rule ? [rule] : [];
    expect(categorize(tx({ id: "t2", counterpartyNorm: "ICA NARA SOFO" }), rules)?.categoryId).toBe("livsmedel");
    expect(categorize(tx({ id: "t3", counterpartyNorm: "ICA KVANTUM" }), rules)).toBeNull();
  });

  it("lär in hela motparten för ett vanligt första ord som SWISH", () => {
    const { rule } = learnFromManualChoice({ transaction: tx({ id: "t1", counterpartyNorm: "SWISH ANNA" }), categoryId: "vänner", alwaysDoThis: true, rules: [], newId: counter() });
    expect(rule).toMatchObject({ pattern: "SWISH ANNA" });
    expect(categorize(tx({ id: "t2", counterpartyNorm: "SWISH KALLE" }), rule ? [rule] : [])).toBeNull();
  });

  it("uppdaterar en befintlig inlärd regel för samma mönster i stället för att skapa en ny", () => {
    const existing: CategoryRule = { id: "r-lärd", match: "counterparty_prefix", pattern: "ICA NARA SOFO", categoryId: "gammal", source: "learned" };
    const { rule } = learnFromManualChoice({ transaction: tx({ id: "t1" }), categoryId: "ny", alwaysDoThis: true, rules: [existing], newId: counter() });
    expect(rule).toEqual({ ...existing, categoryId: "ny" });
  });

  it("en mallregel ändras aldrig, men en inlärd regel skapas som vinner över den", () => {
    const { rule } = learnFromManualChoice({ transaction: tx({ id: "t1" }), categoryId: "ny", alwaysDoThis: true, rules: [templateIca], newId: counter() });
    expect(rule).toMatchObject({ source: "learned", pattern: "ICA NARA SOFO", categoryId: "ny" });
    expect(rule?.id).not.toBe(templateIca.id);
  });

  it("utan \"Gör alltid så\" ändras bara den här transaktionen", () => {
    const result = learnFromManualChoice({ transaction: tx({ id: "t1" }), categoryId: "ny", alwaysDoThis: false, rules: [], newId: counter() });
    expect(result.rule).toBeNull();
    expect(result.transaction.categorySource).toBe("manual");
  });

  it("utan motpart går det inte att lära sig någon regel", () => {
    const result = learnFromManualChoice({ transaction: tx({ id: "t1", counterpartyNorm: "" }), categoryId: "ny", alwaysDoThis: true, rules: [], newId: counter() });
    expect(result.rule).toBeNull();
  });
});

describe("applicera regler bakåt (KK-18-C)", () => {
  const learned: CategoryRule = { id: "r-lärd", match: "counterparty_prefix", pattern: "ICA", categoryId: "livsmedel", source: "learned" };

  it("ändrar bara transaktioner som inte är manuella och som får en annan kategori", () => {
    const transactions = [
      tx({ id: "okategoriserad" }),
      tx({ id: "mall", categoryId: "mat", categorySource: "template" }),
      tx({ id: "manuell", categoryId: "egen", categorySource: "manual" }),
      tx({ id: "redan-rätt", categoryId: "livsmedel", categorySource: "learned" }),
      tx({ id: "annan-butik", counterpartyNorm: "COOP" }),
    ];
    expect(applyRules(transactions, [templateIca, learned])).toEqual([
      { id: "okategoriserad", categoryId: "livsmedel", categorySource: "learned" },
      { id: "mall", categoryId: "livsmedel", categorySource: "learned" },
    ]);
  });

  it("en transaktion vars regel har försvunnit blir okategoriserad igen, men en manuell rörs aldrig", () => {
    const transactions = [
      tx({ id: "lärd", categoryId: "livsmedel", categorySource: "learned", counterpartyNorm: "COOP" }),
      tx({ id: "manuell", categoryId: "egen", categorySource: "manual", counterpartyNorm: "COOP" }),
    ];
    expect(applyRules(transactions, [templateIca])).toEqual([{ id: "lärd", categoryId: null, categorySource: "none" }]);
  });

  it("att applicera två gånger ger inga fler ändringar", () => {
    const transactions = [tx({ id: "a" }), tx({ id: "b", counterpartyNorm: "ICA KVANTUM" })];
    const changes = applyRules(transactions, [learned]);
    const updated = transactions.map((t) => ({ ...t, ...changes.find((c) => c.id === t.id) }));
    expect(applyRules(updated, [learned])).toEqual([]);
  });
});

describe("en regels effekt bakåt (KK-18-B, KK-18-C)", () => {
  const learned: CategoryRule = { id: "r-ica", match: "counterparty_prefix", pattern: "ICA NARA SOFO", categoryId: "mat", source: "learned" };
  const history = [
    tx({ id: "a" }),
    tx({ id: "b", categoryId: "gammal", categorySource: "template" }),
    tx({ id: "c", categoryId: "hushall", categorySource: "manual" }),
    tx({ id: "d", counterpartyNorm: "ICA NARA SOFO STHLM" }),
    tx({ id: "e", counterpartyNorm: "SL" }),
    tx({ id: "f", categoryId: "mat", categorySource: "learned" }),
  ];

  it("ger de transaktioner regeln skulle ändra, och räknar manuella som skyddas", () => {
    expect(ruleReach(history, [templateIca, learned], "r-ica")).toEqual({
      changes: [
        { id: "a", categoryId: "mat", categorySource: "learned" },
        { id: "b", categoryId: "mat", categorySource: "learned" },
        { id: "d", categoryId: "mat", categorySource: "learned" },
      ],
      protectedManual: 1,
    });
  });

  it("rör inte transaktioner där en annan regel vinner", () => {
    const longer: CategoryRule = { ...learned, id: "r-lang", pattern: "ICA NARA SOFO STHLM", categoryId: "annat" };
    const { changes } = ruleReach(history, [learned, longer], "r-ica");
    expect(changes.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("en regel som inte finns ger ingen effekt", () => {
    expect(ruleReach(history, [learned], "saknas")).toEqual({ changes: [], protectedManual: 0 });
  });
});
