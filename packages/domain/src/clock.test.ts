import { describe, expect, it } from "vitest";
import { fixedClock, stockholmDate, todayInStockholm } from "./clock.ts";

describe("svensk kalenderdag för ett UTC-ögonblick (KK-33)", () => {
  it.each([
    ["sent kortköp sista oktober blir 1 november (vintertid, UTC+1)", "2026-10-31T23:30:00Z", "2026-11-01"],
    ["strax före midnatt svensk tid är fortfarande samma dag", "2026-10-31T22:59:59Z", "2026-10-31"],
    ["sommartid (UTC+2): 22.30 UTC är redan nästa dag", "2026-06-30T22:30:00Z", "2026-07-01"],
    ["sommartid (UTC+2): 21.59 UTC är samma dag", "2026-06-30T21:59:59Z", "2026-06-30"],
    ["natten då sommartiden börjar", "2026-03-29T00:30:00Z", "2026-03-29"],
    ["natten då sommartiden slutar", "2026-10-24T22:30:00Z", "2026-10-25"],
    ["nyårsnatten", "2026-12-31T23:00:00Z", "2027-01-01"],
  ])("%s", (_, instant, date) => {
    expect(stockholmDate(new Date(instant))).toBe(date);
  });

  it("dagens datum hämtas via Clock-porten, så att tester inte beror på serverns klocka", () => {
    expect(todayInStockholm(fixedClock("2026-10-31T23:30:00Z"))).toBe("2026-11-01");
  });

  it("avvisar ett ogiltigt ögonblick", () => {
    expect(() => stockholmDate(new Date("inte ett datum"))).toThrow("Ogiltigt ögonblick");
  });
});
