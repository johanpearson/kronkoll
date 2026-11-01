import { describe, expect, it } from "vitest";
import { fixedClock } from "./clock.ts";
import { budgetPeriodForKey, budgetPeriodOf, currentBudgetPeriod, weekStart } from "./period.ts";

describe("kalendermånad som budgetperiod (standard, KK-33)", () => {
  it("bokföringsdagen 31 oktober hör till oktober (KK-33-A)", () => {
    expect(budgetPeriodOf("2026-10-31", 1)).toEqual({ key: "2026-10", start: "2026-10-01", end: "2026-10-31" });
  });

  it("räknar februari rätt, även skottår", () => {
    expect(budgetPeriodOf("2026-02-14", 1).end).toBe("2026-02-28");
    expect(budgetPeriodOf("2028-02-14", 1).end).toBe("2028-02-29");
  });

  it("flyttar inte den 1:a även om den är en helgdag", () => {
    expect(budgetPeriodOf("2027-01-01", 1)).toEqual({ key: "2027-01", start: "2027-01-01", end: "2027-01-31" });
  });

  it("aktuell period räknas på svensk tid via Clock (V-u-period)", () => {
    // 23.30 UTC den 31 oktober är 00.30 den 1 november i Sverige
    expect(currentBudgetPeriod(fixedClock("2026-10-31T23:30:00Z"), 1).key).toBe("2026-11");
    expect(currentBudgetPeriod(fixedClock("2026-10-31T22:30:00Z"), 1).key).toBe("2026-10");
  });
});

describe("period från lön till lön (KK-34)", () => {
  it("lönedag på helgdag: perioden börjar närmast föregående bankdag (KK-34-A)", () => {
    // 25 dec 2026 är juldagen och 24 dec julafton, så perioden börjar onsdag 23 dec
    expect(budgetPeriodOf("2026-12-23", 25)).toEqual({ key: "2027-01", start: "2026-12-23", end: "2027-01-24" });
  });

  it("dagen före periodstart hör till föregående period", () => {
    expect(budgetPeriodOf("2026-12-22", 25)).toEqual({ key: "2026-12", start: "2026-11-25", end: "2026-12-22" });
  });

  it("lönedag på söndag flyttas till fredagen", () => {
    expect(budgetPeriodOf("2026-10-23", 25)).toEqual({ key: "2026-11", start: "2026-10-23", end: "2026-11-24" });
  });

  it("perioden slutar dagen innan nästa (flyttade) periodstart", () => {
    expect(budgetPeriodOf("2026-11-30", 25).end).toBe("2026-12-22");
  });

  it("tidig startdag hör till samma månad, sen startdag till nästa", () => {
    expect(budgetPeriodOf("2026-11-10", 5).key).toBe("2026-11");
    expect(budgetPeriodOf("2026-11-20", 16).key).toBe("2026-12");
    expect(budgetPeriodOf("2026-11-20", 15).key).toBe("2026-11");
  });

  it("nästa periods flyttade start kan ligga i föregående månad", () => {
    // 2 jan 2027 är en lördag och 1 jan nyårsdagen, och 31 dec nyårsafton: starten blir 30 dec
    expect(budgetPeriodOf("2026-12-31", 2)).toEqual({ key: "2027-01", start: "2026-12-30", end: "2027-02-01" });
    expect(budgetPeriodOf("2026-12-29", 2)).toEqual({ key: "2026-12", start: "2026-12-02", end: "2026-12-29" });
  });

  it("hanterar årsskiftet bakåt", () => {
    expect(budgetPeriodOf("2027-01-10", 25)).toEqual({ key: "2027-01", start: "2026-12-23", end: "2027-01-24" });
  });

  it.each([0, 29, 31, 2.5])("avvisar startdag %s", (day) => {
    expect(() => budgetPeriodOf("2026-11-10", day)).toThrow(RangeError);
  });

  it("avvisar ett ogiltigt datum", () => {
    expect(() => budgetPeriodOf("2026-02-30", 1)).toThrow(RangeError);
  });
});

describe("period från nyckel (för /api/budgets/{period})", () => {
  it.each([
    ["2026-10", 1, { key: "2026-10", start: "2026-10-01", end: "2026-10-31" }],
    ["2027-01", 25, { key: "2027-01", start: "2026-12-23", end: "2027-01-24" }],
    ["2026-11", 5, { key: "2026-11", start: "2026-11-05", end: "2026-12-03" }],
  ])("%s med startdag %i", (key, day, expected) => {
    expect(budgetPeriodForKey(key, day)).toEqual(expected);
  });

  it("nyckeln och perioden stämmer överens åt båda hållen", () => {
    for (const day of [1, 5, 15, 16, 25, 28]) {
      for (const date of ["2026-01-01", "2026-03-31", "2026-06-15", "2026-12-24", "2026-12-31", "2027-01-31"]) {
        const period = budgetPeriodOf(date, day);
        expect(budgetPeriodForKey(period.key, day)).toEqual(period);
        expect(date >= period.start && date <= period.end).toBe(true);
      }
    }
  });

  it.each(["2026-13", "2026-1", "26-01", ""])("avvisar nyckeln %j", (key) => {
    expect(() => budgetPeriodForKey(key, 1)).toThrow(RangeError);
  });
});

describe("veckan börjar på måndag (KK-4-B)", () => {
  it.each([
    ["måndag", "2026-11-02", "2026-11-02"],
    ["onsdag", "2026-11-04", "2026-11-02"],
    ["söndag", "2026-11-08", "2026-11-02"],
    ["över ett årsskifte", "2027-01-01", "2026-12-28"],
  ])("%s %s → %s", (_, date, monday) => {
    expect(weekStart(date)).toBe(monday);
  });
});
