import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyRules, categorize, explainCategory, orderRules, ruleReach, type CategorizableTransaction, type CategoryRule } from "./categorize.ts";

function tx(overrides: Partial<CategorizableTransaction> & { id: string }): CategorizableTransaction {
  return { counterpartyNorm: "ICA MAXI HOOR", description: "", categoryId: null, categorySource: "none", ...overrides };
}

const ica: CategoryRule = { id: "ica", match: "counterparty_prefix", pattern: "ICA", categoryId: "mat", source: "learned" };
const maxi: CategoryRule = { id: "maxi", match: "description_contains", pattern: "MAXI", categoryId: "hushall", source: "learned" };
const mall: CategoryRule = { id: "mall", match: "counterparty_exact", pattern: "ICA MAXI HOOR", categoryId: "fika", source: "template" };

describe("användarens ordning på regler (KK-58-C)", () => {
  it("utan ordning gäller den inbyggda prioriteten: prefix före Innehåller", () => {
    expect(categorize(tx({ id: "t" }), [ica, maxi])?.ruleId).toBe("ica");
  });

  it("den egna regel som står först vinner, oavsett slag och längd", () => {
    const rules = orderRules([ica, maxi, mall], ["maxi", "ica"]);
    expect(categorize(tx({ id: "t" }), rules)?.ruleId).toBe("maxi");
    expect(categorize(tx({ id: "t" }), orderRules(rules, ["ica", "maxi"]))?.ruleId).toBe("ica");
  });

  it("platsen avgör även längre ner i listan, inte bara för den första", () => {
    const coop: CategoryRule = { id: "coop", match: "counterparty_prefix", pattern: "COOP", categoryId: "mat", source: "learned" };
    // Ingen av de två som träffar står först, men MAXI står före ICA.
    expect(categorize(tx({ id: "t" }), orderRules([ica, maxi, coop], ["coop", "maxi", "ica"]))?.ruleId).toBe("maxi");
  });

  it("ger de egna reglerna position i den ordning de står, och rör inte mallreglerna", () => {
    expect(orderRules([ica, maxi, mall], ["maxi", "ica"])).toEqual([
      { ...ica, position: 1 },
      { ...maxi, position: 0 },
      mall,
    ]);
  });

  it("mallregler kommer sist, även en exakt mallregel", () => {
    expect(categorize(tx({ id: "t" }), orderRules([ica, mall], ["ica"]))?.ruleId).toBe("ica");
    // Utan egna regler som träffar gäller mallen.
    expect(categorize(tx({ id: "t" }), orderRules([mall], []))?.ruleId).toBe("mall");
  });

  it("en egen regel utan position, t.ex. en ny, kommer efter de ordnade men före mallen", () => {
    const ordered = orderRules([ica, mall], ["ica"]);
    const unordered: CategoryRule = { ...maxi, id: "ny" };
    expect(categorize(tx({ id: "t" }), [unordered, ...ordered])?.ruleId).toBe("ica");
    expect(categorize(tx({ id: "t", counterpartyNorm: "COOP", description: "MAXI" }), [unordered, ...ordered, mall])?.ruleId).toBe("ny");
  });

  it("ordningen måste innehålla varje egen regel exakt en gång", () => {
    expect(() => orderRules([ica, maxi], ["ica"])).toThrow("Ordningen måste innehålla varje egen regel en gång");
    expect(() => orderRules([ica, maxi], ["ica", "ica"])).toThrow("Ordningen måste innehålla varje egen regel en gång");
    expect(() => orderRules([ica, maxi], ["ica", "maxi", "maxi"])).toThrow("Ordningen måste innehålla varje egen regel en gång");
    expect(() => orderRules([ica, maxi], ["ica", "mall"])).toThrow("Ordningen måste innehålla varje egen regel en gång");
    expect(() => orderRules([ica, maxi, mall], ["ica", "maxi", "mall"])).toThrow("Ordningen måste innehålla varje egen regel en gång");
  });
});

describe("skriv över även manuellt kategoriserade (KK-58-B)", () => {
  const history = [
    tx({ id: "a" }),
    tx({ id: "b", categoryId: "fritid", categorySource: "manual" }),
    tx({ id: "c", categoryId: "mat", categorySource: "manual" }),
    tx({ id: "d", counterpartyNorm: "COOP", categoryId: "fritid", categorySource: "manual" }),
  ];

  it("utan valet skyddas manuella, och de räknas", () => {
    expect(ruleReach(history, [ica], "ica")).toEqual({ changes: [{ id: "a", categoryId: "mat", categorySource: "learned" }], protectedManual: 2 });
  });

  it("med valet får även manuella där regeln vinner regelns kategori, och inga är skyddade", () => {
    expect(ruleReach(history, [ica], "ica", { overrideManual: true })).toEqual({
      changes: [
        { id: "a", categoryId: "mat", categorySource: "learned" },
        // Samma kategori men vald för hand: blir regelns, så att nästa ändring av regeln gäller den.
        { id: "b", categoryId: "mat", categorySource: "learned" },
        { id: "c", categoryId: "mat", categorySource: "learned" },
      ],
      protectedManual: 0,
    });
  });

  it("en manuell där en annan regel vinner rörs inte ens med valet", () => {
    const rules = orderRules([ica, maxi], ["maxi", "ica"]);
    expect(ruleReach([tx({ id: "b", categoryId: "fritid", categorySource: "manual" })], rules, "ica", { overrideManual: true }).changes).toEqual([]);
  });

  it("efter överskrivningen skyddas ett nytt manuellt val som vanligt", () => {
    const after = tx({ id: "b", categoryId: "fritid", categorySource: "manual" });
    expect(applyRules([after], [ica])).toEqual([]);
  });
});

describe("egenskaper för reglerna (KK-58-E)", () => {
  const names = ["ICA MAXI HOOR", "ICA NARA", "COOP", "LIDL HOOR", "MAXI LEKSAKER", ""];
  const transaction = fc.record({
    counterpartyNorm: fc.constantFrom(...names),
    description: fc.constantFrom("", "Kortköp MAXI", "lidl  hoor", "Hyra"),
    categoryId: fc.constantFrom(null, "mat", "fritid"),
    categorySource: fc.constantFrom("none" as const, "manual" as const, "learned" as const, "template" as const),
  });
  const transactions = fc.uniqueArray(transaction, { maxLength: 12, selector: (t) => JSON.stringify(t) }).map((list) => list.map((t, i) => ({ ...t, id: `t${String(i)}` })));
  const rule = fc.record({
    match: fc.constantFrom("counterparty_exact" as const, "counterparty_prefix" as const, "description_contains" as const),
    pattern: fc.constantFrom("ICA", "ICA MAXI HOOR", "MAXI", "LIDL HOOR", "COOP", "HYRA"),
    categoryId: fc.constantFrom("mat", "fritid", "hushall"),
    source: fc.constantFrom("learned" as const, "template" as const),
  });
  const rules = fc.array(rule, { maxLength: 6 }).map((list) => list.map((r, i): CategoryRule => ({ ...r, id: `r${String(i)}` })));
  const ordered = rules.chain((list) =>
    fc.shuffledSubarray(list.filter((r) => r.source === "learned").map((r) => r.id), { minLength: list.filter((r) => r.source === "learned").length }).map((order) => orderRules(list, order)),
  );

  const applied = (list: readonly CategorizableTransaction[], ruleList: readonly CategoryRule[]) => {
    const changes = applyRules(list, ruleList);
    return list.map((t) => ({ ...t, ...changes.find((c) => c.id === t.id) }));
  };

  it("att tillämpa alla regler två gånger ger samma resultat som en gång", () => {
    fc.assert(
      fc.property(transactions, ordered, (list, ruleList) => {
        expect(applyRules(applied(list, ruleList), ruleList)).toEqual([]);
      }),
    );
  });

  it("resultatet beror inte på i vilken ordning transaktionerna eller reglerna kommer", () => {
    fc.assert(
      fc.property(
        transactions.chain((list) => fc.tuple(fc.constant(list), fc.shuffledSubarray(list, { minLength: list.length }))),
        ordered.chain((list) => fc.tuple(fc.constant(list), fc.shuffledSubarray(list, { minLength: list.length }))),
        ([list, shuffled], [ruleList, shuffledRules]) => {
          const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
          expect([...applyRules(shuffled, shuffledRules)].sort(byId)).toEqual([...applyRules(list, ruleList)].sort(byId));
        },
      ),
    );
  });
});

describe("varför fick den här kategorin? (KK-58-D)", () => {
  const rules = orderRules([ica, maxi, mall], ["maxi", "ica"]);

  it("säger vilken regel som gav kategorin och vilka andra som också träffar, i den ordning de vinner", () => {
    expect(explainCategory(tx({ id: "t", categoryId: "hushall", categorySource: "learned" }), rules)).toEqual({ source: "learned", ruleId: "maxi", alsoMatched: ["ica", "mall"] });
    expect(explainCategory(tx({ id: "t", counterpartyNorm: "ICA MAXI HOOR", categoryId: "fika", categorySource: "template" }), [mall])).toEqual({ source: "template", ruleId: "mall", alsoMatched: [] });
  });

  it("en manuell kategori kommer inte från någon regel, men reglerna som träffar visas", () => {
    expect(explainCategory(tx({ id: "t", categoryId: "fritid", categorySource: "manual" }), rules)).toEqual({ source: "manual", ruleId: null, alsoMatched: ["maxi", "ica", "mall"] });
    // Även när det manuella valet råkar vara samma kategori som regeln ger.
    expect(explainCategory(tx({ id: "t", categoryId: "hushall", categorySource: "manual" }), rules).ruleId).toBeNull();
  });

  it("utan kategori, eller när kategorin inte längre är den regeln ger, pekas ingen regel ut", () => {
    expect(explainCategory(tx({ id: "t", counterpartyNorm: "SL" }), rules)).toEqual({ source: "none", ruleId: null, alsoMatched: [] });
    // Kategorin kom från en regel som har tagits bort eller ändrats.
    expect(explainCategory(tx({ id: "t", categoryId: "fritid", categorySource: "learned" }), rules)).toEqual({ source: "learned", ruleId: null, alsoMatched: ["maxi", "ica", "mall"] });
  });
});
