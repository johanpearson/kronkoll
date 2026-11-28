import { describe, expect, it } from "vitest";
import {
  LOAN_PATTERN_MIN_LENGTH,
  linkLoans,
  loanMatchPreview,
  loanPaidInPeriod,
  matchLoan,
  normalizeLoanPattern,
  type LoanMatcher,
  type LoanTransaction,
} from "./loan-match.ts";

// Påhittade lån och kontonummer i samma format som bankens (KK-13, KK-59-E).
const BOLAN: LoanMatcher = { loanId: "lan1", patterns: ["9020-12 345 67"] };
const BILLAN: LoanMatcher = { loanId: "lan2", patterns: ["Exempel Finans", "OCR 4455"] };

let seq = 0;
function tx(overrides: Partial<LoanTransaction> = {}): LoanTransaction {
  return {
    id: `t${String(++seq)}`,
    date: "2026-11-27",
    status: "booked",
    amountMinor: -812_500,
    counterparty: "",
    description: "Betalning 9020 1234567",
    loanId: null,
    loanSource: null,
    ...overrides,
  };
}

describe("matchningstexter (KK-59-A, KK-59-E)", () => {
  it("jämförs utan mellanslag, bindestreck, punkter och snedstreck, och oavsett versaler", () => {
    expect(normalizeLoanPattern(" 9020-12 345.67 ")).toBe("90201234567");
    expect(normalizeLoanPattern("Exempel finans/AB")).toBe("EXEMPELFINANSAB");
  });

  it("är för korta under tre tecken, så att de inte träffar allt", () => {
    expect(LOAN_PATTERN_MIN_LENGTH).toBe(3);
    expect(normalizeLoanPattern(" 4-5 ")).toBeNull();
    expect(normalizeLoanPattern("SBA")).toBe("SBA");
  });
});

describe("vilket lån en betalning hör till (KK-59-B)", () => {
  it("hittar kontonumret i meddelandet även när banken skriver det på annat sätt", () => {
    expect(matchLoan(tx(), [BILLAN, BOLAN])).toBe("lan1");
    expect(matchLoan(tx({ description: "BG 9020.12.34567" }), [BOLAN])).toBe("lan1");
  });

  it("söker i både motpart och meddelande", () => {
    expect(matchLoan(tx({ counterparty: "EXEMPEL FINANS AB", description: "" }), [BOLAN, BILLAN])).toBe("lan2");
  });

  it("bara utbetalningar: en insättning med samma text kopplas inte", () => {
    expect(matchLoan(tx({ amountMinor: 812_500 }), [BOLAN])).toBeNull();
    expect(matchLoan(tx({ amountMinor: 0 }), [BOLAN])).toBeNull();
  });

  it("ingen träff, för korta mönster och borttagna transaktioner ger null", () => {
    expect(matchLoan(tx({ description: "ICA NARA EXEMPEL" }), [BOLAN, BILLAN])).toBeNull();
    expect(matchLoan(tx({ description: "AB 12" }), [{ loanId: "kort", patterns: ["ab", ""] }])).toBeNull();
    expect(matchLoan(tx({ status: "removed" }), [BOLAN])).toBeNull();
    // Ett för kort mönster blir inte till texten "null" som råkar finnas i meddelandet.
    expect(matchLoan(tx({ description: "NULL" }), [{ loanId: "kort", patterns: ["1"] }])).toBeNull();
  });

  it("när flera lån träffar vinner det längsta mönstret, sedan lånets id", () => {
    // "EXEMPELFINANS" (13 tecken) är längre än kontonumret (11 siffror).
    const text = tx({ description: "EXEMPEL FINANS 9020-12 345 67" });
    expect(matchLoan(text, [BOLAN, BILLAN])).toBe("lan2");
    const samma = tx({ description: "SAMMA" });
    expect(matchLoan(samma, [{ loanId: "b", patterns: ["samma"] }, { loanId: "a", patterns: ["SAMMA"] }])).toBe("a");
    expect(matchLoan(samma, [{ loanId: "a", patterns: ["samma"] }, { loanId: "b", patterns: ["SAMMA"] }])).toBe("a");
    // Ett kortare mönster efter ett längre tar inte över, och ett längre efter ett kortare gör det.
    const lang = tx({ description: "EXEMPEL FINANS AB" });
    expect(matchLoan(lang, [{ loanId: "z", patterns: ["EXEMPEL FINANS"] }, { loanId: "a", patterns: ["EXEMPEL"] }])).toBe("z");
    expect(matchLoan(lang, [{ loanId: "a", patterns: ["EXEMPEL"] }, { loanId: "z", patterns: ["EXEMPEL FINANS"] }])).toBe("z");
  });
});

describe("koppla betalningar till lån (KK-59-B)", () => {
  it("kopplar det som träffar, tar bort en automatisk koppling som inte längre träffar, och rör inte det som redan stämmer", () => {
    const ny = tx();
    const gammal = tx({ description: "ICA", loanId: "lan1", loanSource: "auto" });
    const redan = tx({ loanId: "lan1", loanSource: "auto" });
    expect(linkLoans([ny, gammal, redan], [BOLAN])).toEqual([
      { id: ny.id, loanId: "lan1" },
      { id: gammal.id, loanId: null },
    ]);
  });

  it("en manuell koppling eller en manuellt borttagen koppling rörs aldrig", () => {
    const borttagen = tx({ loanId: null, loanSource: "manual" });
    const egen = tx({ description: "ICA", loanId: "lan2", loanSource: "manual" });
    expect(linkLoans([borttagen, egen], [BOLAN])).toEqual([]);
  });

  it("flyttar en automatisk koppling när ett annat lån passar bättre", () => {
    const t = tx({ loanId: "lan2", loanSource: "auto" });
    expect(linkLoans([t], [BOLAN])).toEqual([{ id: t.id, loanId: "lan1" }]);
  });
});

describe("förhandsvisning innan lånet sparas (KK-59-A)", () => {
  it("räknar träffarna och visar de tre senaste som exempel", () => {
    const rows = [
      tx({ id: "a", date: "2026-08-27" }),
      tx({ id: "b", date: "2026-11-27" }),
      tx({ id: "c", date: "2026-09-27" }),
      tx({ id: "d", date: "2026-10-27" }),
      tx({ id: "x", description: "ICA" }),
    ];
    const preview = loanMatchPreview(rows, ["9020-12 345 67"]);
    expect(preview.count).toBe(4);
    expect(preview.examples.map((t) => t.id)).toEqual(["b", "d", "c"]);
  });

  it("utan giltiga mönster träffar ingenting", () => {
    expect(loanMatchPreview([tx()], ["", "1"])).toEqual({ count: 0, examples: [] });
    expect(loanMatchPreview([tx({ amountMinor: 100 }), tx({ status: "removed" })], ["9020-12 345 67"]).count).toBe(0);
  });
});

describe("Betalt denna period (KK-59-C)", () => {
  const NOVEMBER = { key: "2026-11", start: "2026-11-01", end: "2026-11-30" };
  const paid = (rows: LoanTransaction[], today: string) => loanPaidInPeriod({ loanId: "lan1", transactions: rows, period: NOVEMBER, today });

  it("summerar lånets betalningar i perioden som positivt belopp, med senaste datum", () => {
    const rows = [
      tx({ loanId: "lan1", date: "2026-11-27", amountMinor: -512_500 }),
      tx({ loanId: "lan1", date: "2026-11-01", amountMinor: -200_000 }),
      tx({ loanId: "lan1", date: "2026-11-05", amountMinor: -100_000 }),
      tx({ loanId: "lan1", date: "2026-10-31", amountMinor: -999 }),
      tx({ loanId: "lan1", date: "2026-12-01", amountMinor: -888 }),
      tx({ loanId: "lan2", date: "2026-11-27", amountMinor: -111 }),
      tx({ loanId: "lan1", date: "2026-11-28", amountMinor: -222, status: "removed" }),
    ];
    expect(paid(rows, "2026-11-28")).toEqual({ paidMinor: 812_500, lastPaidOn: "2026-11-27", missing: false });
    // Periodens sista dag räknas.
    expect(paid([tx({ loanId: "lan1", date: "2026-11-30" }), tx({ loanId: "lan1", date: "2026-11-02" })], "2026-11-30")).toMatchObject({ lastPaidOn: "2026-11-30" });
  });

  it("varnar när perioden är slut och ingen betalning har kommit, men inte innan dess", () => {
    expect(paid([], "2026-11-29")).toEqual({ paidMinor: 0, lastPaidOn: null, missing: false });
    expect(paid([], "2026-11-30")).toEqual({ paidMinor: 0, lastPaidOn: null, missing: true });
    expect(paid([], "2026-12-03").missing).toBe(true);
    expect(paid([tx({ loanId: "lan1", date: "2026-11-27" })], "2026-11-30").missing).toBe(false);
  });
});
