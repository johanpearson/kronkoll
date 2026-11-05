import { describe, expect, it } from "vitest";
import { loanMonthly, loanTotals, RATE_ENDING_DAYS, rateFixedStatus, type Loan } from "./loans.ts";

const kr = (amount: number) => amount * 100;

/** Påhittade lån enligt planens exempel (KK-13). */
const bolan: Loan = { balanceMinor: kr(2_400_000), interestRateBp: 350, amortizationMinor: kr(4_000), rateFixedUntil: "2026-12-15" };
const billan: Loan = { balanceMinor: kr(86_000), interestRateBp: 695, amortizationMinor: kr(2_450), rateFixedUntil: null };

describe("loanMonthly: månadskostnad och hur den fördelar sig (KK-36-B)", () => {
  it("2 400 000 kr till 3,5 % och 4 000 kr amortering kostar 11 000 kr/mån, varav 7 000 kr ränta", () => {
    expect(loanMonthly(bolan)).toEqual({ interestMinor: kr(7_000), amortizationMinor: kr(4_000), costMinor: kr(11_000) });
  });

  it("räntan avrundas till hela ören", () => {
    expect(loanMonthly(billan)).toEqual({ interestMinor: 49808, amortizationMinor: kr(2_450), costMinor: 294808 });
    expect(loanMonthly({ ...billan, balanceMinor: 100, interestRateBp: 600 })).toMatchObject({ interestMinor: 1 });
  });

  it("ett lån utan ränta eller utan skuld kostar bara amorteringen", () => {
    expect(loanMonthly({ ...bolan, interestRateBp: 0 })).toEqual({ interestMinor: 0, amortizationMinor: kr(4_000), costMinor: kr(4_000) });
    expect(loanMonthly({ ...bolan, balanceMinor: 0, amortizationMinor: 0 })).toEqual({ interestMinor: 0, amortizationMinor: 0, costMinor: 0 });
  });

  it("stoppar ogiltiga lån", () => {
    expect(() => loanMonthly({ ...bolan, balanceMinor: -1 })).toThrow("Skulden kan inte vara negativ");
    expect(() => loanMonthly({ ...bolan, amortizationMinor: -1 })).toThrow("Amorteringen kan inte vara negativ");
    expect(() => loanMonthly({ ...bolan, balanceMinor: 1.5 })).toThrow("Belopp måste vara ett heltal i öre");
    for (const interestRateBp of [-1, 10001, 3.5]) expect(() => loanMonthly({ ...bolan, interestRateBp })).toThrow("Räntan måste vara mellan 0 och 100 %");
    expect(loanMonthly({ ...bolan, balanceMinor: 1200, interestRateBp: 10_000 })).toMatchObject({ interestMinor: 100 });
  });
});

describe("loanTotals: total skuld och månadskostnad (KK-36-C)", () => {
  it("summerar skuld, ränta, amortering och kostnad", () => {
    expect(loanTotals([bolan, billan])).toEqual({
      balanceMinor: kr(2_486_000),
      interestMinor: kr(7_000) + 49808,
      amortizationMinor: kr(6_450),
      costMinor: kr(11_000) + 294808,
    });
    expect(loanTotals([])).toEqual({ balanceMinor: 0, interestMinor: 0, amortizationMinor: 0, costMinor: 0 });
  });
});

describe("rateFixedStatus: bindningstid som snart går ut (KK-36-C)", () => {
  it("flaggar bindningstid som går ut inom 60 dagar, även i dag, men inte senare", () => {
    expect(RATE_ENDING_DAYS).toBe(60);
    expect(rateFixedStatus(bolan, "2026-11-04")).toEqual({ fixed: true, daysLeft: 41, ending: true });
    expect(rateFixedStatus(bolan, "2026-12-15")).toEqual({ fixed: true, daysLeft: 0, ending: true });
    expect(rateFixedStatus({ ...bolan, rateFixedUntil: "2027-01-03" }, "2026-11-04")).toEqual({ fixed: true, daysLeft: 60, ending: true });
    expect(rateFixedStatus({ ...bolan, rateFixedUntil: "2027-01-04" }, "2026-11-04")).toEqual({ fixed: true, daysLeft: 61, ending: false });
  });

  it("en bindningstid som har gått ut är rörlig, och rörlig ränta flaggas inte", () => {
    expect(rateFixedStatus(bolan, "2026-12-16")).toEqual({ fixed: false, daysLeft: null, ending: false });
    expect(rateFixedStatus(billan, "2026-11-04")).toEqual({ fixed: false, daysLeft: null, ending: false });
  });
});
