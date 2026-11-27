import { describe, expect, it } from "vitest";
import { parsePercent } from "./percent.ts";

describe("parsePercent", () => {
  it("läser procent med decimalkomma mellan 0 och 100", () => {
    expect(parsePercent("31,5")).toBe(31.5);
    expect(parsePercent(" 0 ")).toBe(0);
    expect(parsePercent("100")).toBe(100);
    expect(parsePercent("100,5")).toBeNull();
    expect(parsePercent("-1")).toBeNull();
    expect(parsePercent("")).toBeNull();
    expect(parsePercent("3,333")).toBeNull();
  });
});
