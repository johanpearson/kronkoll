import { describe, expect, it } from "vitest";
import { easterSunday, isBankDay, previousBankDayOnOrBefore, swedishBankHolidays } from "./bankdays.ts";

describe("påskdagen", () => {
  it.each([
    [2024, "2024-03-31"],
    [2025, "2025-04-20"],
    [2026, "2026-04-05"],
    [2027, "2027-03-28"],
    [2038, "2038-04-25"],
  ])("%i: %s", (year, date) => {
    expect(easterSunday(year)).toBe(date);
  });
});

describe("svenska bankfria dagar 2026", () => {
  const holidays = swedishBankHolidays(2026);

  it.each([
    ["nyårsdagen", "2026-01-01"],
    ["trettondedag jul", "2026-01-06"],
    ["långfredagen", "2026-04-03"],
    ["annandag påsk", "2026-04-06"],
    ["första maj", "2026-05-01"],
    ["Kristi himmelsfärdsdag", "2026-05-14"],
    ["nationaldagen", "2026-06-06"],
    ["midsommarafton", "2026-06-19"],
    ["midsommardagen", "2026-06-20"],
    ["alla helgons dag", "2026-10-31"],
    ["julafton", "2026-12-24"],
    ["juldagen", "2026-12-25"],
    ["annandag jul", "2026-12-26"],
    ["nyårsafton", "2026-12-31"],
  ])("%s %s", (_, date) => {
    expect(holidays.has(date)).toBe(true);
  });

  it("räknar inte vanliga vardagar som helgdagar", () => {
    expect(holidays.has("2026-12-23")).toBe(false);
    expect(holidays.has("2026-04-02")).toBe(false);
  });
});

describe("bankdagar", () => {
  it.each([
    ["vanlig onsdag", "2026-12-23", true],
    ["lördag", "2026-12-19", false],
    ["söndag", "2026-10-25", false],
    ["julafton på en torsdag", "2026-12-24", false],
    ["juldagen på en fredag", "2026-12-25", false],
    ["midsommarafton", "2027-06-25", false],
    ["dagen efter annandag påsk", "2026-04-07", true],
  ])("%s (%s): %s", (_, date, expected) => {
    expect(isBankDay(date)).toBe(expected);
  });

  it.each([
    ["en bankdag är sig själv", "2026-11-25", "2026-11-25"],
    ["söndag flyttas till fredag", "2026-10-25", "2026-10-23"],
    ["juldagen flyttas förbi julafton till den 23:e (KK-34-A)", "2026-12-25", "2026-12-23"],
    ["annandag påsk flyttas förbi helgen och långfredagen", "2026-04-06", "2026-04-02"],
    ["nyårsdagen flyttas till året innan, förbi nyårsafton", "2027-01-01", "2026-12-30"],
  ])("%s", (_, date, expected) => {
    expect(previousBankDayOnOrBefore(date)).toBe(expected);
  });
});
