import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { accountBalances, includesPending } from "./balances.ts";

describe("bokfört och disponibelt saldo (KK-56-F)", () => {
  it("ett bokfört saldo från banken plus preliminära utgifter och insättningar ger disponibelt", () => {
    expect(accountBalances({ amountMinor: 1_000_00, type: "CLBD" }, [-250_00, -12_50, 100_00])).toEqual({
      bookedMinor: 1_000_00,
      availableMinor: 837_50,
      pendingMinor: -162_50,
    });
  });

  it("ett saldo där banken redan räknat med de preliminära ger bokfört genom att dra av dem", () => {
    expect(accountBalances({ amountMinor: 837_50, type: "XPCD" }, [-250_00, -12_50, 100_00])).toEqual({
      bookedMinor: 1_000_00,
      availableMinor: 837_50,
      pendingMinor: -162_50,
    });
  });

  it("utan preliminära är saldona lika, även för ett negativt kortsaldo", () => {
    expect(accountBalances({ amountMinor: -3_200_10, type: "ITBD" }, [])).toEqual({ bookedMinor: -3_200_10, availableMinor: -3_200_10, pendingMinor: 0 });
  });

  it("en okänd eller saknad saldotyp räknas som bokförd, som före #252", () => {
    expect(accountBalances({ amountMinor: 500_00, type: null }, [-100_00])).toEqual({ bookedMinor: 500_00, availableMinor: 400_00, pendingMinor: -100_00 });
    expect(accountBalances({ amountMinor: 500_00, type: "OKÄND" }, [-100_00]).bookedMinor).toBe(500_00);
  });

  it("vet vilka saldotyper som har de preliminära inräknade", () => {
    expect(["XPCD", "ITAV", "CLAV"].filter(includesPending)).toEqual(["XPCD", "ITAV", "CLAV"]);
    expect(["CLBD", "ITBD", "OPBD", "OKÄND", null].filter(includesPending)).toEqual([]);
  });

  it("avvisar belopp som inte är heltal öre", () => {
    expect(() => accountBalances({ amountMinor: 1.5, type: "CLBD" }, [])).toThrow("Belopp måste vara ett heltal i öre");
    expect(() => accountBalances({ amountMinor: 100, type: "CLBD" }, [0.5])).toThrow("Belopp måste vara ett heltal i öre");
  });

  it("disponibelt minus bokfört är alltid summan av de preliminära, oavsett saldotyp", () => {
    const minor = fc.integer({ min: -10_000_000, max: 10_000_000 });
    fc.assert(
      fc.property(minor, fc.array(minor, { maxLength: 20 }), fc.constantFrom("CLBD", "XPCD", "ITAV", null), (amountMinor, pending, type) => {
        const b = accountBalances({ amountMinor, type }, pending);
        const sum = pending.reduce((s, p) => s + p, 0);
        expect(b.pendingMinor).toBe(sum);
        expect(b.availableMinor - b.bookedMinor).toBe(sum);
        expect(includesPending(type) ? b.availableMinor : b.bookedMinor).toBe(amountMinor);
      }),
    );
  });
});
