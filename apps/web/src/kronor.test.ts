import { describe, expect, it } from "vitest";
import { parseKronor } from "./kronor.ts";

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
