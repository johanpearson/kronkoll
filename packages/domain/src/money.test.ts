import { describe, expect, it } from "vitest";
import { parseAmount, sumMinor } from "./money.ts";

describe("parseAmount: bankens decimalsträng till heltal öre (D-money)", () => {
  it.each([
    ["123.45", 12345],
    ["-123.45", -12345],
    ["+7.5", 750],
    ["12", 1200],
    ["0.07", 7],
    ["-0.01", -1],
    ["0", 0],
    ["1000000.00", 100000000],
  ])("%s → %i öre", (text, ore) => {
    expect(parseAmount(text)).toBe(ore);
  });

  it("räknar exakt även där flyttal avrundar fel", () => {
    // Med flyttal blir t.ex. 4.35 * 100 = 434.99999999999994
    expect(parseAmount("1.00")).toBe(100);
    expect(parseAmount("0.29")).toBe(29);
    expect(parseAmount("4.35")).toBe(435);
    expect(parseAmount("1.15")).toBe(115);
  });

  it("tål blanksteg runt talet", () => {
    expect(parseAmount(" 42.10 ")).toBe(4210);
  });

  it.each(["", "abc", "1.234", "1,50", "1.", ".5", "--1", "1e3", "12 345.00", "NaN", "Infinity"])(
    "avvisar %j",
    (text) => {
      expect(() => parseAmount(text)).toThrow(RangeError);
    },
  );

  it("avvisar belopp som inte ryms som säkert heltal", () => {
    expect(() => parseAmount("90071992547409.92")).toThrow(RangeError);
  });

  it("returnerar aldrig minus noll", () => {
    expect(Object.is(parseAmount("-0.00"), 0)).toBe(true);
  });
});

describe("sumMinor", () => {
  it("summerar heltal öre exakt", () => {
    expect(sumMinor([10, 20, -5])).toBe(25);
    expect(sumMinor([])).toBe(0);
  });

  it("avvisar belopp som inte är heltal öre", () => {
    expect(() => sumMinor([1, 2.5])).toThrow(RangeError);
  });

  it("avvisar en summa som slår över säkert heltal", () => {
    expect(() => sumMinor([Number.MAX_SAFE_INTEGER, 1])).toThrow(RangeError);
  });
});
