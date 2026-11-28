import { describe, expect, it } from "vitest";
import {
  knownAccountFor,
  knownAccountHits,
  linkKnownAccounts,
  knownAccountRules,
  normalizeKnownPattern,
  validateKnownAccount,
  type KnownAccount,
} from "./known-accounts.ts";

const tx = (id: string, description: string, counterpartyNorm = "") => ({ id, description, counterpartyNorm });

const annas: KnownAccount = { id: "k1", name: "Kontot A", patterns: ["ÖVERFÖRING A", "SWISH TILL A"], categoryId: "privat-a" };
const barn: KnownAccount = { id: "k2", name: "Barnspar", patterns: ["BARNSPAR"], categoryId: "sparande-barn" };

describe("matchningstexter för kända konton (KK-54, KK-47)", () => {
  it("normaliseras till versaler och ett mellanslag mellan orden", () => {
    expect(normalizeKnownPattern("  Swish   till\ta ")).toBe("SWISH TILL A");
  });

  it("en tom text avvisas med ett tydligt fel", () => {
    expect(() => normalizeKnownPattern("   ")).toThrow("Matchningstexten får inte vara tom");
  });
});

describe("validera ett känt konto (KK-54-A)", () => {
  it("kräver ett namn", () => {
    expect(() => validateKnownAccount({ ...annas, name: " " })).toThrow("Kontot måste ha ett namn");
  });

  it("kräver minst en matchningstext", () => {
    expect(() => validateKnownAccount({ ...annas, patterns: [] })).toThrow("Minst en matchningstext krävs");
  });

  it("trimmar namnet, normaliserar texterna och tar bort dubbletter", () => {
    expect(validateKnownAccount({ ...annas, name: " Kontot A ", patterns: ["Swish till a", "SWISH  TILL A", "x1"] })).toEqual({
      ...annas,
      patterns: ["SWISH TILL A", "X1"],
    });
  });
});

describe("känt konto som träffar en transaktion (KK-54-B)", () => {
  it("träffar på text i beskrivningen, oavsett versaler", () => {
    expect(knownAccountFor(tx("t1", "swish till a 123"), [annas, barn])?.id).toBe("k1");
  });

  it("ger null när inget träffar", () => {
    expect(knownAccountFor(tx("t1", "ICA MAXI"), [annas, barn])).toBeNull();
  });

  it("längre matchningstext vinner när flera konton träffar", () => {
    const bred: KnownAccount = { id: "k3", name: "Bred", patterns: ["SWISH"], categoryId: "x" };
    expect(knownAccountFor(tx("t1", "Swish till a"), [bred, annas])?.id).toBe("k1");
  });

  it("en manuell koppling går före matchning, även när en text träffar ett annat konto (KK-54-C)", () => {
    expect(knownAccountFor(tx("t1", "Swish till a"), [annas, barn], "k2")?.id).toBe("k2");
  });

  it("en manuell koppling till ett borttaget konto faller tillbaka på matchning", () => {
    expect(knownAccountFor(tx("t1", "Swish till a"), [annas, barn], "borta")?.id).toBe("k1");
  });
});

describe("kända konton som regler (KK-54-B, KK-58)", () => {
  it("ger en Innehåller-regel per matchningstext med kontots kategori", () => {
    const rules = knownAccountRules([annas]);
    expect(rules.map((r) => [r.match, r.pattern, r.categoryId, r.source])).toEqual([
      ["description_contains", "ÖVERFÖRING A", "privat-a", "learned"],
      ["description_contains", "SWISH TILL A", "privat-a", "learned"],
    ]);
    expect(new Set(rules.map((r) => r.id)).size).toBe(2);
  });
});

describe("konto utan kategori", () => {
  it("kopplar ändå, så att namnet visas", () => {
    expect(knownAccountFor(tx("t1", "BARNSPAR"), [{ ...barn, categoryId: null }])?.id).toBe("k2");
  });
});

describe("förhandsvisning av träffar (KK-54-A)", () => {
  it("räknar transaktionerna som träffar kontot, där kontot vinner", () => {
    const txs = [tx("a", "Swish till a"), tx("b", "ÖVERFÖRING A 2"), tx("c", "ICA"), tx("d", "BARNSPAR")];
    expect(knownAccountHits(txs, [annas, barn], "k1")).toBe(2);
    expect(knownAccountHits(txs, [annas, barn], "k2")).toBe(1);
  });

  it("räknar mot ett konto som inte sparats än, med ett nytt id", () => {
    const nytt: KnownAccount = { id: "ny", name: "Nytt", patterns: ["ICA"], categoryId: "mat" };
    expect(knownAccountHits([tx("c", "ICA"), tx("d", "COOP")], [annas, nytt], "ny")).toBe(1);
  });
});

describe("koppla om efter synk (KK-54-B, KK-54-C)", () => {
  const link = (id: string, description: string, knownAccountId: string | null = null, knownAccountSource: "auto" | "manual" | null = null) => ({
    id,
    description,
    counterpartyNorm: "",
    knownAccountId,
    knownAccountSource,
  });

  it("kopplar de som träffar och lämnar övriga", () => {
    expect(linkKnownAccounts([link("a", "Swish till a"), link("b", "ICA")], [annas, barn])).toEqual([{ id: "a", knownAccountId: "k1" }]);
  });

  it("ändrar bara det som skiljer: en redan rätt koppling ger ingen ändring", () => {
    expect(linkKnownAccounts([link("a", "Swish till a", "k1", "auto")], [annas])).toEqual([]);
  });

  it("tar bort en automatisk koppling som inte längre träffar, och byter när ett annat konto vinner", () => {
    expect(linkKnownAccounts([link("a", "ICA", "k1", "auto"), link("b", "BARNSPAR", "k1", "auto")], [annas, barn])).toEqual([
      { id: "a", knownAccountId: null },
      { id: "b", knownAccountId: "k2" },
    ]);
  });

  it("rör aldrig en manuell koppling eller en koppling som användaren tagit bort", () => {
    expect(
      linkKnownAccounts([link("a", "ICA", "k2", "manual"), link("b", "Swish till a", null, "manual")], [annas, barn]),
    ).toEqual([]);
  });
});
