import { describe, expect, it } from "vitest";
import { recurringCharges, type RecurringTransaction } from "./recurring.ts";

const kr = (amount: number) => amount * 100;
const TODAY = "2026-11-05";
let seq = 0;

/** Påhittade dragningar (KK-13). Utbetalningar har negativt belopp. */
function charge(counterparty: string, date: string, amount: number, extra: Partial<RecurringTransaction> = {}): RecurringTransaction {
  seq += 1;
  return { id: `t${String(seq)}`, date, amountMinor: -kr(amount), counterparty, counterpartyNorm: counterparty.toLowerCase(), status: "booked", internal: false, ...extra };
}
const monthly = (name: string, dates: readonly string[], amount: number) => dates.map((d) => charge(name, d, amount));
const NETFLIX = monthly("Netflix", ["2026-07-19", "2026-08-19", "2026-09-19", "2026-10-19"], 149);

describe("recurringCharges: återkommande dragningar (KK-24-A)", () => {
  it("hittar en månadsdragning med nästa förväntade datum och årskostnad", () => {
    expect(recurringCharges(NETFLIX, TODAY)).toEqual([
      { counterparty: "Netflix", counterpartyNorm: "netflix", interval: "monthly", amountMinor: kr(149), lastDate: "2026-10-19", nextExpected: "2026-11-19", yearlyMinor: kr(1_788), occurrences: 4 },
    ]);
  });

  it("hittar en årsdragning och sorterar efter årskostnad, störst först", () => {
    const insurance = [charge("Länsförsäkringar Hem", "2025-02-03", 2_250), charge("Länsförsäkringar Hem", "2026-02-03", 2_340)];
    const result = recurringCharges([...insurance, ...NETFLIX], TODAY);
    expect(result.map((r) => r.counterparty)).toEqual(["Länsförsäkringar Hem", "Netflix"]);
    expect(result[0]).toMatchObject({ interval: "yearly", amountMinor: kr(2_340), nextExpected: "2027-02-03", yearlyMinor: kr(2_340), occurrences: 2 });
  });

  it("kräver tre månadsdragningar men bara två årsdragningar", () => {
    expect(recurringCharges(NETFLIX.slice(2), TODAY)).toEqual([]);
    expect(recurringCharges(NETFLIX.slice(1), TODAY)).toHaveLength(1);
    expect(recurringCharges([charge("Försäkring", "2026-02-03", 2_340)], TODAY)).toEqual([]);
  });

  it("godtar 25–35 dagar mellan månadsdragningar och 350–380 dagar mellan årsdragningar", () => {
    const at = (dates: readonly string[]) => recurringCharges(monthly("Gym", dates, 300), TODAY);
    expect(at(["2026-09-15", "2026-10-10", "2026-11-04"])).toHaveLength(1);
    expect(at(["2026-09-15", "2026-10-09", "2026-11-04"])).toEqual([]);
    expect(at(["2026-08-26", "2026-09-30", "2026-11-04"])).toHaveLength(1);
    expect(at(["2026-08-25", "2026-09-30", "2026-11-04"])).toEqual([]);
    const yearly = (first: string) => recurringCharges([charge("Avgift", first, 500), charge("Avgift", "2026-06-01", 500)], TODAY);
    expect(yearly("2025-06-16")).toHaveLength(1);
    expect(yearly("2025-06-17")).toEqual([]);
    expect(yearly("2025-05-17")).toHaveLength(1);
    expect(yearly("2025-05-16")).toEqual([]);
  });

  it("godtar belopp som skiljer högst 20 % från den senaste dragningen", () => {
    const series = (first: number) => recurringCharges([charge("El", "2026-09-01", first), charge("El", "2026-10-01", 500), charge("El", "2026-11-01", 500)], TODAY);
    expect(series(600)).toHaveLength(1);
    expect(series(400)).toHaveLength(1);
    expect(series(601)).toEqual([]);
    expect(series(399)).toEqual([]);
    expect(recurringCharges([charge("El", "2026-09-01", 450), charge("El", "2026-10-01", 500), charge("El", "2026-11-01", 550)], TODAY)[0]).toMatchObject({ amountMinor: kr(550), yearlyMinor: kr(6_600) });
  });

  it("räknar inte en motpart med fler köp mellan dragningarna, som en matbutik", () => {
    const groceries = [...monthly("ICA", ["2026-09-02", "2026-10-02", "2026-11-02"], 800), charge("ICA", "2026-10-14", 350)];
    expect(recurringCharges(groceries, TODAY)).toEqual([]);
    const earlierExtra = [charge("Netflix", "2026-06-02", 99), ...NETFLIX];
    expect(recurringCharges(earlierExtra, TODAY)[0]).toMatchObject({ occurrences: 4 });
  });

  it("väljer den närmaste dragningen bakåt när flera passar", () => {
    const twice = [charge("Hyra", "2026-08-01", 8_900), charge("Hyra", "2026-08-05", 8_900), ...monthly("Hyra", ["2026-09-01", "2026-10-01"], 8_900)];
    expect(recurringCharges(twice, TODAY)[0]).toMatchObject({ occurrences: 3, lastDate: "2026-10-01" });
  });

  it("slutar visa en serie som inte dragits på över 45 dagar, eller 400 dagar för årsvis", () => {
    expect(recurringCharges(monthly("Spotify", ["2026-07-20", "2026-08-20", "2026-09-20"], 229), TODAY)).toEqual([]);
    expect(recurringCharges(monthly("Spotify", ["2026-07-20", "2026-08-20", "2026-09-20"], 229), "2026-11-04")).toHaveLength(1);
    const yearly = [charge("Bil", "2024-10-01", 3_000), charge("Bil", "2025-10-01", 3_000)];
    expect(recurringCharges(yearly, "2026-11-05")).toHaveLength(1);
    expect(recurringCharges(yearly, "2026-11-06")).toEqual([]);
  });

  it("räknar bara utbetalningar som inte är borttagna, interna eller saknar motpart", () => {
    const base = NETFLIX.slice(1);
    const between = charge("Netflix", "2026-09-30", 149);
    const variants: Partial<RecurringTransaction>[] = [{ status: "removed" }, { internal: true }, { amountMinor: kr(149) }, { amountMinor: 0 }];
    for (const extra of variants) expect(recurringCharges([...base, { ...between, ...extra }], TODAY)).toHaveLength(1);
    expect(recurringCharges([...base, { ...between, status: "pending" }], TODAY)).toEqual([]);
    expect(recurringCharges(base.map((t) => ({ ...t, counterpartyNorm: "" })), TODAY)).toEqual([]);
  });

  it("tål dragningar i valfri ordning", () => {
    expect(recurringCharges([...NETFLIX].reverse(), TODAY)[0]).toMatchObject({ occurrences: 4, lastDate: "2026-10-19" });
  });

  it("använder senaste namnet, klampar nästa datum till månadens slut och sorterar lika kostnad efter namn", () => {
    const end = monthly("Bredband", ["2026-08-31", "2026-09-30", "2026-10-31"], 399).map((t, i) => (i === 2 ? { ...t, counterparty: "Bredband AB" } : t));
    const tie = monthly("Abonnemang", ["2026-08-31", "2026-09-30", "2026-10-31"], 399);
    const swedish = monthly("Ödla", ["2026-08-31", "2026-09-30", "2026-10-31"], 399);
    const result = recurringCharges([...swedish, ...end, ...tie], TODAY);
    expect(result.map((r) => r.counterparty)).toEqual(["Abonnemang", "Bredband AB", "Ödla"]);
    expect(result[1]?.nextExpected).toBe("2026-11-30");
    expect(recurringCharges(monthly("Hyra", ["2026-11-30", "2026-12-31", "2027-01-31"], 100), "2027-02-01")[0]?.nextExpected).toBe("2027-02-28");
  });
});
