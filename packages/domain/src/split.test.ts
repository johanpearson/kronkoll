import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { allocateByCategory, validateSplit } from "./split.ts";

describe("dela upp en transaktion (KK-19, V-u-split)", () => {
  it("−1 240 kr i −900 och −340 godkänns", () => {
    const parts = [
      { categoryId: "hushall", amountMinor: -90000 },
      { categoryId: "fritid-hobby", amountMinor: -34000 },
    ];
    expect(validateSplit(-124000, parts)).toEqual({ ok: true, parts });
  });

  it("−900 och −300 ger felet med kvarvarande −40 kr (KK-19-B)", () => {
    const result = validateSplit(-124000, [
      { categoryId: "hushall", amountMinor: -90000 },
      { categoryId: "fritid-hobby", amountMinor: -30000 },
    ]);
    expect(result).toEqual({
      ok: false,
      error: "split_sum_mismatch",
      expectedMinor: -124000,
      actualMinor: -120000,
      remainingMinor: -4000,
    });
  });

  it("delar för mycket ger ett positivt kvarvarande belopp att ta bort", () => {
    const result = validateSplit(-10000, [
      { categoryId: "a", amountMinor: -6000 },
      { categoryId: "b", amountMinor: -5000 },
    ]);
    expect(result).toMatchObject({ ok: false, remainingMinor: 1000 });
  });

  it("fungerar även för inkomster", () => {
    expect(validateSplit(50000, [{ categoryId: "a", amountMinor: 30000 }, { categoryId: "b", amountMinor: 20000 }]).ok).toBe(true);
  });

  it.each([
    ["färre än två delar", [{ categoryId: "a", amountMinor: -100 }], "too_few_parts"],
    ["en del på noll", [{ categoryId: "a", amountMinor: -100 }, { categoryId: "b", amountMinor: 0 }], "invalid_part"],
    ["en del med fel tecken", [{ categoryId: "a", amountMinor: -200 }, { categoryId: "b", amountMinor: 100 }], "invalid_part"],
    ["en del utan kategori", [{ categoryId: "", amountMinor: -50 }, { categoryId: "b", amountMinor: -50 }], "invalid_part"],
  ])("avvisar %s", (_, parts, error) => {
    expect(validateSplit(-100, parts)).toMatchObject({ ok: false, error });
  });

  it("en transaktion på noll kan inte delas upp", () => {
    expect(validateSplit(0, [{ categoryId: "a", amountMinor: 0 }, { categoryId: "b", amountMinor: 0 }])).toMatchObject({ ok: false, error: "invalid_part" });
  });

  it("avvisar belopp som inte är heltal öre", () => {
    expect(() => validateSplit(-100.5, [])).toThrow(RangeError);
    expect(() => validateSplit(-100, [{ categoryId: "a", amountMinor: -50.5 }, { categoryId: "b", amountMinor: -49.5 }])).toThrow(RangeError);
  });

  it("egenskap: delar som summerar rätt godkänns, och ett fel på x öre ger kvar −x", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 2, maxLength: 6 }),
        fc.integer({ min: -500, max: 500 }).filter((d) => d !== 0),
        (sizes, delta) => {
          const parts = sizes.map((s, i) => ({ categoryId: `k${String(i)}`, amountMinor: -s }));
          const total = parts.reduce((sum, p) => sum + p.amountMinor, 0);
          expect(validateSplit(total, parts).ok).toBe(true);
          const first = parts[0];
          if (first === undefined || first.amountMinor + delta >= 0) return;
          const wrong = [{ ...first, amountMinor: first.amountMinor + delta }, ...parts.slice(1)];
          expect(validateSplit(total, wrong)).toMatchObject({ ok: false, remainingMinor: -delta });
        },
      ),
    );
  });
});

describe("belopp per kategori för budgeten (KK-19-A)", () => {
  it("en uppdelad transaktion räknas i varje dels kategori", () => {
    expect(
      allocateByCategory({ amountMinor: -124000, categoryId: "ovrigt" }, [
        { categoryId: "hushall", amountMinor: -90000 },
        { categoryId: "fritid-hobby", amountMinor: -34000 },
      ]),
    ).toEqual([
      { categoryId: "hushall", amountMinor: -90000 },
      { categoryId: "fritid-hobby", amountMinor: -34000 },
    ]);
  });

  it("utan uppdelning räknas hela beloppet i transaktionens kategori", () => {
    expect(allocateByCategory({ amountMinor: -4500, categoryId: "mat" }, [])).toEqual([{ categoryId: "mat", amountMinor: -4500 }]);
  });

  it("en okategoriserad transaktion utan uppdelning hamnar under null", () => {
    expect(allocateByCategory({ amountMinor: -4500, categoryId: null }, [])).toEqual([{ categoryId: null, amountMinor: -4500 }]);
  });

  it("en uppdelning som inte stämmer används inte, utan hela beloppet räknas som vanligt", () => {
    expect(allocateByCategory({ amountMinor: -1000, categoryId: "mat" }, [{ categoryId: "a", amountMinor: -400 }, { categoryId: "b", amountMinor: -400 }])).toEqual([
      { categoryId: "mat", amountMinor: -1000 },
    ]);
  });
});
