import { describe, expect, it } from "vitest";
import { parseField, parseKronor, toText } from "./kronor.ts";

describe("parseKronor", () => {
  it("tolkar kronor med mellanslag och decimalkomma, och tomt som noll", () => {
    expect(parseKronor("60 000")).toBe(6000000);
    expect(parseKronor("1\u00a0234,5")).toBe(123450);
    expect(parseKronor("")).toBe(0);
  });

  it("avvisar negativa belopp och text", () => {
    expect(parseKronor("-1")).toBeNull();
    expect(parseKronor("tio")).toBeNull();
  });
});

describe("toText", () => {
  it("skriver hela kronor utan decimaler och annars med ören", () => {
    expect(toText(630000)).toBe("6300");
    expect(toText(630050)).toBe("6300,50");
    expect(toText(0)).toBe("0");
  });
});

describe("parseField", () => {
  it("tomt och noll är ingen budget, och ett belopp blir öre", () => {
    expect(parseField("")).toBeNull();
    expect(parseField("0")).toBeNull();
    expect(parseField("6 300,50")).toBe(630050);
  });

  it("text och negativa belopp är inte ett belopp", () => {
    expect(parseField("abc")).toBeUndefined();
    expect(parseField("-5")).toBeUndefined();
  });
});
