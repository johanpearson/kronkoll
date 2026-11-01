import { describe, expect, it } from "vitest";
import { addDays, addMonths, daysBetween, parseDate, weekday } from "./calendar.ts";

describe("kalenderdagar utan klockslag", () => {
  it.each(["2026-1-01", "26-01-01", "2026/01/01", "", "2026-01-01T00:00"])("avvisar formatet %j", (text) => {
    expect(() => parseDate(text)).toThrow(RangeError);
  });

  it.each(["2026-02-29", "2026-04-31", "2026-13-01", "2026-00-10"])("avvisar datumet %s som inte finns", (text) => {
    expect(() => parseDate(text)).toThrow(RangeError);
  });

  it("räknar dagar över månads- och årsskiften utan att påverkas av sommartid", () => {
    expect(addDays("2026-03-28", 2)).toBe("2026-03-30");
    expect(addDays("2026-10-24", 2)).toBe("2026-10-26");
    expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
  });

  it("räknar månader över årsskiften åt båda hållen", () => {
    expect(addMonths({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
    expect(addMonths({ year: 2027, month: 1 }, -1)).toEqual({ year: 2026, month: 12 });
  });

  it("räknar dagar mellan två datum, även över sommartidsbytet", () => {
    expect(daysBetween("2026-03-28", "2026-03-30")).toBe(2);
    expect(daysBetween("2026-11-20", "2026-11-09")).toBe(-11);
  });

  it("ger veckodag med söndag som 0", () => {
    expect(weekday("2026-11-01")).toBe(0);
    expect(weekday("2026-11-07")).toBe(6);
  });
});
