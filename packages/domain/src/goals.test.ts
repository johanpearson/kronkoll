import { describe, expect, it } from "vitest";
import { averageMonthlySaving, forecastGoal } from "./goals.ts";

const kr = (amount: number) => amount * 100;
const TODAY = "2026-11-04";

describe("averageMonthlySaving: snittsparande de senaste 3 månaderna (KK-21)", () => {
  it("delar summan av avsättningarna de senaste 3 månaderna med 3", () => {
    const contributions = [
      { date: "2026-10-28", amountMinor: kr(3000) },
      { date: "2026-09-27", amountMinor: kr(3400) },
      { date: "2026-08-30", amountMinor: kr(3200) },
    ];
    expect(averageMonthlySaving(contributions, TODAY)).toBe(kr(3200));
  });

  it("räknar från dagen efter samma dag för 3 månader sedan till och med i dag", () => {
    const at = (date: string) => averageMonthlySaving([{ date, amountMinor: 300 }], TODAY);
    expect(at("2026-08-04")).toBe(0);
    expect(at("2026-08-05")).toBe(100);
    expect(at(TODAY)).toBe(100);
    expect(at("2026-11-05")).toBe(0);
  });

  it("håller sig inom månaden när 3 månader bakåt saknar samma dag", () => {
    expect(averageMonthlySaving([{ date: "2026-02-28", amountMinor: 300 }], "2026-05-31")).toBe(0);
    expect(averageMonthlySaving([{ date: "2026-03-01", amountMinor: 300 }], "2026-05-31")).toBe(100);
  });

  it("uttag från ett kopplat konto drar ned takten, som kan bli negativ", () => {
    const movements = [
      { date: "2026-10-25", amountMinor: kr(5000) },
      { date: "2026-10-26", amountMinor: kr(-8000) },
    ];
    expect(averageMonthlySaving(movements, TODAY)).toBe(kr(-1000));
  });

  it("avrundar nedåt till hela ören och ger 0 utan rörelser", () => {
    expect(averageMonthlySaving([{ date: "2026-10-01", amountMinor: 100 }], TODAY)).toBe(33);
    expect(averageMonthlySaving([{ date: "2026-10-01", amountMinor: -100 }], TODAY)).toBe(-34);
    expect(averageMonthlySaving([], TODAY)).toBe(0);
  });

  it("kastar för belopp som inte är hela ören, även utanför de 3 månaderna, och för ogiltigt datum", () => {
    expect(() => averageMonthlySaving([{ date: TODAY, amountMinor: 0.5 }], TODAY)).toThrow("Belopp måste vara ett heltal i öre");
    expect(() => averageMonthlySaving([{ date: "2025-01-01", amountMinor: 0.5 }], TODAY)).toThrow("Belopp måste vara ett heltal i öre");
    expect(() => averageMonthlySaving([], "2026-13-01")).toThrow("Ogiltigt datum: 2026-13-01");
  });
});

describe("forecastGoal: när målet nås i nuvarande takt (KK-21-A)", () => {
  const japan = { targetMinor: kr(60000), savedMinor: kr(21500), monthlyRateMinor: kr(3200), targetDate: "2027-08-31", today: TODAY };

  it("60 000 kr, 21 500 sparat och 3 200 kr/mån ger 13 månader, dec. 2027, 4 mån efter måldatum och 4 278 kr/mån som krävs", () => {
    expect(forecastGoal(japan)).toEqual({
      kind: "eta",
      remainingMinor: kr(38500),
      months: 13,
      reachedIn: "2027-12",
      onTrack: false,
      monthsLate: 4,
      requiredPerMonthMinor: 427778,
    });
  });

  it("är i fas när prognosen ligger på eller före måldatum", () => {
    expect(forecastGoal({ ...japan, monthlyRateMinor: kr(5000) })).toMatchObject({ months: 8, reachedIn: "2027-07", onTrack: true, monthsLate: 0 });
    expect(forecastGoal({ ...japan, targetDate: "2027-12-01" })).toMatchObject({ onTrack: true, monthsLate: 0, requiredPerMonthMinor: 296154 });
  });

  it("en sista ofullständig månad räknas som en hel", () => {
    expect(forecastGoal({ ...japan, monthlyRateMinor: kr(38500) })).toMatchObject({ months: 1, reachedIn: "2026-12" });
    expect(forecastGoal({ ...japan, monthlyRateMinor: kr(38500) - 1 })).toMatchObject({ months: 2, reachedIn: "2027-01" });
  });

  it("utan måldatum finns ingen fas och inget krav per månad", () => {
    expect(forecastGoal({ ...japan, targetDate: null })).toMatchObject({ kind: "eta", months: 13, onTrack: null, monthsLate: null, requiredPerMonthMinor: null });
  });

  it("ett måldatum i den här månaden eller tidigare kräver hela resten nu", () => {
    for (const targetDate of ["2026-11-30", "2026-01-15"]) {
      expect(forecastGoal({ ...japan, targetDate })).toMatchObject({ onTrack: false, requiredPerMonthMinor: kr(38500) });
    }
    expect(forecastGoal({ ...japan, targetDate: "2026-11-30" })).toMatchObject({ monthsLate: 13 });
  });

  it("ett mål som redan är nått har inget kvar", () => {
    for (const savedMinor of [kr(60000), kr(61000)]) {
      expect(forecastGoal({ ...japan, savedMinor })).toEqual({ kind: "reached", remainingMinor: 0 });
    }
  });
});

describe("forecastGoal: noll eller negativ takt (KK-21-B)", () => {
  const barnvagn = { targetMinor: kr(8000), savedMinor: kr(1200), targetDate: "2027-03-31", today: TODAY };

  it("ger 'nås inte i nuvarande takt' i stället för ett datum, men säger vad som krävs", () => {
    for (const monthlyRateMinor of [0, kr(-500)]) {
      expect(forecastGoal({ ...barnvagn, monthlyRateMinor })).toEqual({ kind: "never", remainingMinor: kr(6800), requiredPerMonthMinor: kr(1700) });
    }
  });

  it("utan måldatum finns inget krav per månad", () => {
    expect(forecastGoal({ ...barnvagn, monthlyRateMinor: 0, targetDate: null })).toEqual({ kind: "never", remainingMinor: kr(6800), requiredPerMonthMinor: null });
  });
});

describe("forecastGoal: ogiltiga värden", () => {
  const ok = { targetMinor: kr(100), savedMinor: 0, monthlyRateMinor: kr(10), targetDate: null, today: TODAY };

  it("målbeloppet måste vara större än noll", () => {
    expect(() => forecastGoal({ ...ok, targetMinor: 0 })).toThrow("Målbeloppet måste vara större än 0");
  });

  it("belopp måste vara hela ören och datum giltiga", () => {
    expect(() => forecastGoal({ ...ok, savedMinor: 1.5 })).toThrow("Belopp måste vara ett heltal i öre");
    expect(() => forecastGoal({ ...ok, monthlyRateMinor: Number.NaN })).toThrow("Belopp måste vara ett heltal i öre");
    expect(() => forecastGoal({ ...ok, targetMinor: 0.5 })).toThrow("Belopp måste vara ett heltal i öre");
    expect(() => forecastGoal({ ...ok, targetDate: "2027-02-30" })).toThrow("Ogiltigt datum: 2027-02-30");
    expect(() => forecastGoal({ ...ok, today: "4 nov" })).toThrow("Ogiltigt datum: 4 nov");
  });
});
