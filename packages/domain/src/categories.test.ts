import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CATEGORY_TEMPLATE,
  TEMPLATE_RULES,
  addCategory,
  archiveCategory,
  mergeCategories,
  moveCategory,
  renameCategory,
  sortCategories,
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

  it("har underkategorierna som planen anger, i den ordningen", () => {
    const tree = Object.fromEntries(
      mains(CATEGORY_TEMPLATE).map((m) => [m.name, CATEGORY_TEMPLATE.filter((c) => c.parentId === m.id).map((c) => c.name)]),
    );
    expect(tree).toEqual({
      Boende: ["Hyra & avgift", "Låneränta", "El", "Bredband", "Hemförsäkring", "Underhåll"],
      Mat: ["Livsmedel", "Restaurang & café", "Systembolaget"],
      Transport: ["Kollektivtrafik", "Bil & bränsle", "Parkering", "Taxi"],
      Barn: ["Mat & blöjor", "Kläder", "Förskola", "Aktiviteter"],
      Hushåll: ["Förbrukning", "Möbler & inredning", "Elektronik"],
      Hälsa: ["Apotek", "Vård", "Träning"],
      Kläder: ["Vuxenkläder", "Skor", "Accessoarer"],
      Nöje: ["Bio & evenemang", "Bar & uteliv", "Spel"],
      Fritid: ["Hobby", "Sport", "Resor"],
      Abonnemang: ["Streaming", "Mobil", "Tidningar", "Programvara"],
      "Sparande & överföringar": ["Sparande", "Amortering", "Överföringar", "Kortfaktura"],
      Övrigt: ["Avgifter", "Gåvor", "Övrigt"],
      Inkomst: ["Lön", "Föräldrapenning", "Övrigt"],
    });
  });

  it.each([
    ["ICA KVANTUM", "mat-livsmedel"],
    ["COOP KONSUM", "mat-livsmedel"],
    ["WILLYS ODENPLAN", "mat-livsmedel"],
    ["HEMKOP CITY", "mat-livsmedel"],
    ["LIDL", "mat-livsmedel"],
    ["SYSTEMBOLAGET", "mat-systembolaget"],
    ["APOTEKET HJARTAT", "halsa-apotek"],
    ["APOTEK GRUNDEN", "halsa-apotek"],
    ["NETFLIX", "abonnemang-streaming"],
    ["NETFLIX.COM", "abonnemang-streaming"],
    ["SPOTIFY", "abonnemang-streaming"],
    ["FORSAKRINGSKASSAN", "inkomst-foraldrapenning"],
  ])("mallregeln känner igen %s", (counterpartyNorm, categoryId) => {
    const tx = { id: "t", counterpartyNorm, description: "", categoryId: null, categorySource: "none" as const };
    expect(categorize(tx, TEMPLATE_RULES)?.categoryId).toBe(categoryId);
  });

  it("mallreglerna har stabila id:n av mönstret", () => {
    expect(TEMPLATE_RULES.map((r) => r.id)).toContain("mall-netflix-com");
    expect(TEMPLATE_RULES.find((r) => r.pattern === "ICA")?.id).toBe("mall-ica");
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
    expect(() => renameCategory(CATEGORY_TEMPLATE, "mat", "  ")).toThrow("Kategorin måste ha ett namn");
    expect(() => renameCategory(CATEGORY_TEMPLATE, "finns-inte", "X")).toThrow("Okänd kategori: finns-inte");
    expect(() => renameCategory(CATEGORY_TEMPLATE, "mat-livsmedel", "systembolaget")).toThrow(
      "Det finns redan en kategori som heter systembolaget",
    );
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
    expect(() => addCategory(CATEGORY_TEMPLATE, { parentId: "mat-livsmedel", name: "Frukt", newId: () => "ny" })).toThrow("Kategorier kan bara ha två nivåer");
    expect(() => addCategory(CATEGORY_TEMPLATE, { parentId: "finns-inte", name: "X", newId: () => "ny" })).toThrow(RangeError);
    const archived = archiveCategory(CATEGORY_TEMPLATE, "barn");
    expect(() => addCategory(archived, { parentId: "barn", name: "X", newId: () => "ny" })).toThrow("Huvudkategorin är arkiverad");
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
    expect(() => mergeCategories({ categories: archived, fromId: "mat-systembolaget", intoId: "mat-livsmedel", transactions, rules })).toThrow(
      "Det går inte att slå ihop med en arkiverad kategori",
    );
  });

  it.each([
    ["samma kategori", "mat", "mat", "En kategori kan inte slås ihop med sig själv"],
    ["olika nivåer", "mat", "mat-livsmedel", "Kategorierna måste ligga på samma nivå"],
    ["olika typer", "boende", "inkomst", "Kategorierna måste vara av samma typ"],
    ["okänd kategori", "finns-inte", "mat", "Okänd kategori"],
  ])("avvisar %s", (_, fromId, intoId, message) => {
    expect(() => mergeCategories({ categories: CATEGORY_TEMPLATE, fromId, intoId, transactions, rules })).toThrow(message);
  });
});

const MAT = ["mat-livsmedel", "mat-restaurang-cafe", "mat-systembolaget"];
/** Underkategorierna till Mat i den ordning de visas. */
const matOrder = (categories: readonly Category[]) =>
  sortCategories(categories.filter((c) => c.parentId === "mat")).map((c) => c.id);

describe("ordna kategorier (KK-18-A, #251)", () => {
  it("kategorier utan plats visas på namn, och de med plats först, i sin ordning", () => {
    expect(matOrder(CATEGORY_TEMPLATE)).toEqual(MAT);
    const placed = CATEGORY_TEMPLATE.map((c) => (c.id === "mat-systembolaget" ? { ...c, position: 0 } : c));
    expect(matOrder(placed)).toEqual(["mat-systembolaget", "mat-livsmedel", "mat-restaurang-cafe"]);
  });

  it("kategorier med samma plats, eller utan plats, ordnas på namn oavsett hur de kommer in", () => {
    const subs = CATEGORY_TEMPLATE.filter((c) => c.parentId === "mat");
    expect(sortCategories(subs.toReversed()).map((c) => c.id)).toEqual(MAT);
    const same = subs.toReversed().map((c) => ({ ...c, position: 3 }));
    expect(sortCategories(same).map((c) => c.id)).toEqual(MAT);
    const placed = subs.map((c) => (c.id === "mat-systembolaget" ? { ...c, position: 1 } : c.id === "mat-restaurang-cafe" ? { ...c, position: 0 } : c));
    expect(sortCategories(placed).map((c) => c.id)).toEqual(["mat-restaurang-cafe", "mat-systembolaget", "mat-livsmedel"]);
  });

  it("flyttar en kategori före en annan bland syskonen och numrerar om från noll", () => {
    const moved = moveCategory(CATEGORY_TEMPLATE, "mat-systembolaget", "mat-livsmedel");
    expect(matOrder(moved)).toEqual(["mat-systembolaget", "mat-livsmedel", "mat-restaurang-cafe"]);
    expect(MAT.map((id) => find(moved, id)?.position).sort()).toEqual([0, 1, 2]);
  });

  it("utan plats att flytta före hamnar den sist", () => {
    expect(matOrder(moveCategory(CATEGORY_TEMPLATE, "mat-livsmedel", null))).toEqual(["mat-restaurang-cafe", "mat-systembolaget", "mat-livsmedel"]);
  });

  it("ändrar bara syskonen: andra huvudkategorier, deras underkategorier och andra typer ligger kvar", () => {
    const moved = moveCategory(CATEGORY_TEMPLATE, "mat", "boende");
    const order = sortCategories(moved.filter((c) => c.parentId === null && c.kind === "expense")).map((c) => c.id);
    expect(order.indexOf("mat") + 1).toBe(order.indexOf("boende"));
    const untouched = (c: Category) => c.parentId !== null || c.kind !== "expense";
    expect(moved.filter(untouched)).toEqual(CATEGORY_TEMPLATE.filter(untouched));
  });

  it("flytten är oförändrad om den görs igen", () => {
    const once = moveCategory(CATEGORY_TEMPLATE, "mat-systembolaget", "mat-livsmedel");
    expect(moveCategory(once, "mat-systembolaget", "mat-livsmedel")).toEqual(once);
  });

  it("avvisar okänd kategori, arkiverad, före sig själv och före någon på en annan nivå eller av en annan typ", () => {
    expect(() => moveCategory(CATEGORY_TEMPLATE, "finns-inte", null)).toThrow("Okänd kategori: finns-inte");
    expect(() => moveCategory(CATEGORY_TEMPLATE, "mat", "finns-inte")).toThrow("Okänd kategori: finns-inte");
    expect(() => moveCategory(archiveCategory(CATEGORY_TEMPLATE, "mat"), "mat", null)).toThrow("Kategorin är arkiverad");
    expect(() => moveCategory(CATEGORY_TEMPLATE, "mat", "mat")).toThrow("En kategori kan inte flyttas före sig själv");
    expect(() => moveCategory(CATEGORY_TEMPLATE, "mat-livsmedel", "boende-el")).toThrow("Kategorierna måste ligga på samma nivå och vara av samma typ");
    expect(() => moveCategory(CATEGORY_TEMPLATE, "mat", "inkomst")).toThrow("Kategorierna måste ligga på samma nivå och vara av samma typ");
  });

  it("egenskap: efter varje flytt står kategorin precis före målet, och platserna är 0..n-1 utan dubbletter", () => {
    const ids = CATEGORY_TEMPLATE.filter((c) => c.parentId === "boende").map((c) => c.id);
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.constantFrom(...ids), fc.constantFrom(null, ...ids)), { minLength: 1, maxLength: 12 }), (steps) => {
        let state: readonly Category[] = CATEGORY_TEMPLATE;
        for (const [id, before] of steps) {
          if (id === before) continue;
          state = moveCategory(state, id, before);
          const order = sortCategories(state.filter((c) => c.parentId === "boende")).map((c) => c.id);
          expect(order.indexOf(id)).toBe(before === null ? order.length - 1 : order.indexOf(before) - 1);
          expect(state.filter((c) => c.parentId === "boende").map((c) => c.position).sort()).toEqual(ids.map((_, i) => i));
        }
      }),
    );
  });
});
