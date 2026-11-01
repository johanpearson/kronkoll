import { describe, expect, it } from "vitest";
import {
  CATEGORY_TEMPLATE,
  TEMPLATE_RULES,
  addCategory,
  archiveCategory,
  mergeCategories,
  renameCategory,
  type Category,
} from "./categories.ts";
import { categorize } from "./categorize.ts";

const mains = (categories: readonly Category[]) => categories.filter((c) => c.parentId === null);
const find = (categories: readonly Category[], id: string) => categories.find((c) => c.id === id);

describe("svensk startmall (KK-18-A, V-u-template)", () => {
  it("har 12 huvudkategorier för utgifter och överföringar, plus Inkomst", () => {
    const expenseMains = mains(CATEGORY_TEMPLATE).filter((c) => c.kind !== "income");
    expect(expenseMains.map((c) => c.name)).toEqual([
      "Boende", "Mat", "Transport", "Barn", "Hushåll", "Hälsa",
      "Kläder", "Nöje", "Fritid", "Abonnemang", "Sparande & överföringar", "Övrigt",
    ]);
    expect(mains(CATEGORY_TEMPLATE).filter((c) => c.kind === "income").map((c) => c.name)).toEqual(["Inkomst"]);
  });

  it("varje huvudkategori har underkategorier, och allt är på högst två nivåer", () => {
    for (const main of mains(CATEGORY_TEMPLATE)) {
      expect(CATEGORY_TEMPLATE.filter((c) => c.parentId === main.id).length).toBeGreaterThan(0);
    }
    for (const sub of CATEGORY_TEMPLATE.filter((c) => c.parentId !== null)) {
      expect(find(CATEGORY_TEMPLATE, sub.parentId ?? "")?.parentId).toBeNull();
    }
  });

  it("har stabila, unika id:n och underkategorier ärver huvudkategorins typ", () => {
    const ids = CATEGORY_TEMPLATE.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(find(CATEGORY_TEMPLATE, "mat-livsmedel")).toMatchObject({ name: "Livsmedel", parentId: "mat" });
    for (const sub of CATEGORY_TEMPLATE.filter((c) => c.parentId !== null)) {
      expect(sub.kind).toBe(find(CATEGORY_TEMPLATE, sub.parentId ?? "")?.kind);
    }
  });

  it("överföringar och inkomster har egna typer, så att de inte räknas som utgift", () => {
    expect(find(CATEGORY_TEMPLATE, "sparande-overforingar")?.kind).toBe("transfer");
    expect(find(CATEGORY_TEMPLATE, "inkomst-lon")?.kind).toBe("income");
  });

  it("lånebetalningar delas i låneränta (utgift) och amortering (sparande) (KK-36-B)", () => {
    expect(find(CATEGORY_TEMPLATE, "boende-laneranta")).toMatchObject({ name: "Låneränta", kind: "expense" });
    expect(find(CATEGORY_TEMPLATE, "sparande-overforingar-amortering")).toMatchObject({ name: "Amortering", kind: "transfer" });
  });

  it("mallreglerna pekar bara på kategorier som finns, och känner igen vanliga motparter", () => {
    const ids = new Set(CATEGORY_TEMPLATE.map((c) => c.id));
    for (const rule of TEMPLATE_RULES) {
      expect(ids.has(rule.categoryId)).toBe(true);
      expect(rule.source).toBe("template");
    }
    const tx = (counterpartyNorm: string) => ({ id: "t", counterpartyNorm, description: "", categoryId: null, categorySource: "none" as const });
    expect(categorize(tx("ICA NARA SOFO"), TEMPLATE_RULES)?.categoryId).toBe("mat-livsmedel");
    expect(categorize(tx("SL"), TEMPLATE_RULES)?.categoryId).toBe("transport-kollektivtrafik");
  });
});

describe("byt namn", () => {
  it("byter namn", () => {
    expect(find(renameCategory(CATEGORY_TEMPLATE, "mat", "Mat & dryck"), "mat")?.name).toBe("Mat & dryck");
  });

  it("avvisar tomt namn, okänd kategori och dubblett bland syskonen", () => {
    expect(() => renameCategory(CATEGORY_TEMPLATE, "mat", "  ")).toThrow(RangeError);
    expect(() => renameCategory(CATEGORY_TEMPLATE, "finns-inte", "X")).toThrow(RangeError);
    expect(() => renameCategory(CATEGORY_TEMPLATE, "mat-livsmedel", "systembolaget")).toThrow(RangeError);
  });

  it("samma namn under olika huvudkategorier är tillåtet", () => {
    expect(() => renameCategory(CATEGORY_TEMPLATE, "barn-klader", "Vuxenkläder")).not.toThrow();
  });
});

describe("lägg till", () => {
  it("lägger till en underkategori som ärver typen", () => {
    const { categories, category } = addCategory(CATEGORY_TEMPLATE, { parentId: "mat", name: "Godis", newId: () => "ny" });
    expect(category).toEqual({ id: "ny", parentId: "mat", name: "Godis", kind: "expense", archived: false });
    expect(categories).toHaveLength(CATEGORY_TEMPLATE.length + 1);
  });

  it("lägger till en ny huvudkategori för utgifter", () => {
    expect(addCategory(CATEGORY_TEMPLATE, { parentId: null, name: "Husdjur", newId: () => "ny" }).category).toMatchObject({ parentId: null, kind: "expense" });
  });

  it("tillåter bara två nivåer och bara under en aktiv huvudkategori", () => {
    expect(() => addCategory(CATEGORY_TEMPLATE, { parentId: "mat-livsmedel", name: "Frukt", newId: () => "ny" })).toThrow(RangeError);
    expect(() => addCategory(CATEGORY_TEMPLATE, { parentId: "finns-inte", name: "X", newId: () => "ny" })).toThrow(RangeError);
    const archived = archiveCategory(CATEGORY_TEMPLATE, "barn");
    expect(() => addCategory(archived, { parentId: "barn", name: "X", newId: () => "ny" })).toThrow(RangeError);
  });
});

describe("arkivera", () => {
  it("arkiverar en huvudkategori tillsammans med dess underkategorier, men inget annat", () => {
    const result = archiveCategory(CATEGORY_TEMPLATE, "barn");
    expect(result.filter((c) => c.archived).map((c) => c.id).sort()).toEqual(
      CATEGORY_TEMPLATE.filter((c) => c.id === "barn" || c.parentId === "barn").map((c) => c.id).sort(),
    );
  });

  it("avvisar en okänd kategori", () => {
    expect(() => archiveCategory(CATEGORY_TEMPLATE, "finns-inte")).toThrow(RangeError);
  });
});

describe("slå ihop (V-u-template)", () => {
  const transactions = [
    { id: "t1", categoryId: "mat-systembolaget" },
    { id: "t2", categoryId: "mat-livsmedel" },
    { id: "t3", categoryId: null },
  ];
  const rules = [
    { id: "r1", match: "counterparty_prefix" as const, pattern: "SYSTEMBOLAGET", categoryId: "mat-systembolaget", source: "template" as const },
    { id: "r2", match: "counterparty_prefix" as const, pattern: "ICA", categoryId: "mat-livsmedel", source: "learned" as const },
  ];

  it("flyttar transaktioner och regler och arkiverar den gamla kategorin", () => {
    const result = mergeCategories({ categories: CATEGORY_TEMPLATE, fromId: "mat-systembolaget", intoId: "mat-livsmedel", transactions, rules });
    expect(result.transactionChanges).toEqual([{ id: "t1", categoryId: "mat-livsmedel" }]);
    expect(result.ruleChanges).toEqual([{ ...rules[0], categoryId: "mat-livsmedel" }]);
    expect(find(result.categories, "mat-systembolaget")?.archived).toBe(true);
    expect(find(result.categories, "mat-livsmedel")?.archived).toBe(false);
  });

  it("vid ihopslagning av huvudkategorier flyttas underkategorierna med", () => {
    const result = mergeCategories({ categories: CATEGORY_TEMPLATE, fromId: "noje", intoId: "fritid", transactions: [], rules: [] });
    const movedSubs = CATEGORY_TEMPLATE.filter((c) => c.parentId === "noje").map((c) => c.id);
    for (const id of movedSubs) expect(find(result.categories, id)?.parentId).toBe("fritid");
    expect(find(result.categories, "noje")?.archived).toBe(true);
  });

  it("avvisar ihopslagning med en arkiverad kategori", () => {
    const archived = archiveCategory(CATEGORY_TEMPLATE, "mat-livsmedel");
    expect(() => mergeCategories({ categories: archived, fromId: "mat-systembolaget", intoId: "mat-livsmedel", transactions, rules })).toThrow(RangeError);
  });

  it.each([
    ["samma kategori", "mat", "mat"],
    ["olika nivåer", "mat", "mat-livsmedel"],
    ["olika typer", "boende", "inkomst"],
    ["okänd kategori", "finns-inte", "mat"],
  ])("avvisar %s", (_, fromId, intoId) => {
    expect(() => mergeCategories({ categories: CATEGORY_TEMPLATE, fromId, intoId, transactions, rules })).toThrow(RangeError);
  });
});
