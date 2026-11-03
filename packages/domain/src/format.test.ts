import { describe, expect, it } from "vitest";
import { formatDateIso, formatDateShort, formatSek } from "./format.ts";

const NBSP = " ";
const MINUS = "−";

describe("formatSek (KK-4-A)", () => {
  it("visar öre som kronor med svenskt tal- och valutaformat", () => {
    expect(formatSek(1234567)).toBe(`12${NBSP}345,67${NBSP}kr`);
  });

  it("visar negativa belopp med minustecken", () => {
    expect(formatSek(-41250)).toBe(`${MINUS}412,50${NBSP}kr`);
  });

  it("visar noll och enstaka ören korrekt", () => {
    expect(formatSek(0)).toBe(`0,00${NBSP}kr`);
    expect(formatSek(5)).toBe(`0,05${NBSP}kr`);
  });

  it("avvisar belopp som inte är heltal öre", () => {
    expect(() => formatSek(12.5)).toThrow("Belopp måste vara ett heltal i öre");
    expect(() => formatSek(Number.MAX_SAFE_INTEGER + 1)).toThrow("Belopp måste vara ett heltal i öre");
  });
});

describe("datumformat (KK-4-B)", () => {
  it("visar kort svenskt datum i listor", () => {
    expect(formatDateShort("2026-11-03")).toBe("3 nov. 2026");
  });

  it("visar ISO-datum i formulär", () => {
    expect(formatDateIso("2026-11-03")).toBe("2026-11-03");
  });

  it("avvisar ogiltiga datum", () => {
    expect(() => formatDateShort("2026-02-30")).toThrow("Ogiltigt datum: 2026-02-30");
    expect(() => formatDateIso("3/11/2026")).toThrow("Ogiltigt datum: 3/11/2026");
  });
});
