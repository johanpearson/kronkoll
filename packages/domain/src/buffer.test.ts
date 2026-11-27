import { describe, expect, it } from "vitest";
import { bufferTotals, bufferTrend, savingKindOf, type BufferTransaction } from "./buffer.ts";
import { budgetPeriodForKey } from "./period.ts";

const NOVEMBER = budgetPeriodForKey("2026-11", 1);
const tx = (overrides: Partial<BufferTransaction>): BufferTransaction => ({
  date: "2026-11-01",
  amountMinor: 0,
  status: "booked",
  savingKind: null,
  ...overrides,
});

describe("bufferten per period (KK-55-A, V-u-roles)", () => {
  it("insatt är sparande från Inkomst/Utgift och insättningar från uteslutna konton, uttaget är uttag från sparande", () => {
    const totals = bufferTotals(
      [
        tx({ amountMinor: -200000, savingKind: "saving" }),
        tx({ amountMinor: 50000, savingKind: "saving_deposit" }),
        tx({ amountMinor: 150000, savingKind: "saving_withdrawal" }),
        tx({ amountMinor: 30000, savingKind: "saving_withdrawal", status: "pending" }),
        tx({ amountMinor: -34900 }),
      ],
      NOVEMBER,
    );
    expect(totals).toEqual({ period: "2026-11", depositedMinor: 250000, withdrawnMinor: 180000, withdrawalCount: 2 });
  });

  it("räknar bara periodens dagar och inte borttagna", () => {
    const totals = bufferTotals(
      [
        tx({ date: NOVEMBER.start, amountMinor: 100, savingKind: "saving_withdrawal" }),
        tx({ date: NOVEMBER.end, amountMinor: -200, savingKind: "saving" }),
        tx({ date: "2026-10-31", amountMinor: 999, savingKind: "saving_withdrawal" }),
        tx({ date: "2026-12-01", amountMinor: 999, savingKind: "saving_withdrawal" }),
        tx({ amountMinor: 999, savingKind: "saving_withdrawal", status: "removed" }),
      ],
      NOVEMBER,
    );
    expect(totals).toEqual({ period: "2026-11", depositedMinor: 200, withdrawnMinor: 100, withdrawalCount: 1 });
  });

  it("ger noll utan buffert, och en trend med en rad per period i samma ordning", () => {
    const october = budgetPeriodForKey("2026-10", 1);
    const rows = bufferTrend([tx({ date: "2026-10-01", amountMinor: 500, savingKind: "saving_withdrawal" })], [october, NOVEMBER]);
    expect(rows).toEqual([
      { period: "2026-10", depositedMinor: 0, withdrawnMinor: 500, withdrawalCount: 1 },
      { period: "2026-11", depositedMinor: 0, withdrawnMinor: 0, withdrawalCount: 0 },
    ]);
  });

  it("avvisar belopp som inte är heltal öre", () => {
    expect(() => bufferTotals([tx({ amountMinor: 1.5, savingKind: "saving" })], NOVEMBER)).toThrow("Belopp måste vara ett heltal i öre");
  });

  it("översätter överföringens orsak till vad som sparas om bufferten", () => {
    expect(savingKindOf("saving")).toBe("saving");
    expect(savingKindOf("saving_withdrawal")).toBe("saving_withdrawal");
    expect(savingKindOf("saving_deposit")).toBe("saving_deposit");
    for (const reason of ["pair", "manual", "hidden", "card_payment", "rule", "account", "none"] as const) expect(savingKindOf(reason)).toBeNull();
  });
});
