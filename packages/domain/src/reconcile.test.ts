import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  reconcile,
  type ImportedTransaction,
  type ReconcileResult,
  type StoredTransaction,
} from "./reconcile.ts";

const TODAY = "2026-11-20";

// Gemensam räknare, så att nya id aldrig krockar mellan två importer i samma test.
let sequence = 0;
function counter(prefix = "tx") {
  return () => `${prefix}_${String(++sequence)}`;
}

function imported(overrides: Partial<ImportedTransaction> = {}): ImportedTransaction {
  return {
    accountId: "acc_1",
    providerTxId: null,
    status: "booked",
    transactionDate: "2026-11-10",
    bookingDate: "2026-11-10",
    amountMinor: -4500,
    counterpartyNorm: "espresso house",
    ...overrides,
  };
}

function stored(overrides: Partial<StoredTransaction> = {}): StoredTransaction {
  return { id: "tx_old", ...imported(), lastSeenOn: "2026-11-10", ...overrides };
}

/** Det nya tillståndet efter att resultatet har sparats. */
function apply(existing: readonly StoredTransaction[], result: ReconcileResult): StoredTransaction[] {
  const updated = new Map(result.updated.map((tx) => [tx.id, tx]));
  return [...existing.map((tx) => updated.get(tx.id) ?? tx), ...result.inserted];
}

function importInto(
  existing: readonly StoredTransaction[],
  incoming: readonly ImportedTransaction[],
  options: { today?: string; accountIds?: readonly string[]; newId?: () => string } = {},
) {
  const result = reconcile({
    existing,
    incoming,
    accountIds: options.accountIds ?? ["acc_1", "acc_2"],
    today: options.today ?? TODAY,
    newId: options.newId ?? counter(),
  });
  return { result, state: apply(existing, result) };
}

describe("dedup mellan hämtningar (KK-9-A)", () => {
  it("samma transaktioner två gånger ger en rad var och inga ändringar andra gången", () => {
    const batch = [imported({ providerTxId: "b1" }), imported({ amountMinor: -12900, counterpartyNorm: "ica" })];
    const first = importInto([], batch);
    expect(first.state).toHaveLength(2);

    const second = importInto(first.state, batch);
    expect(second.state).toHaveLength(2);
    expect(second.result).toEqual({ inserted: [], updated: [] });
  });

  it("två identiska köp samma dag blir två rader, och fler hämtningar ändrar inte det (R-8)", () => {
    const coffee = imported();
    const first = importInto([], [coffee, coffee]);
    expect(first.state).toHaveLength(2);
    expect(importInto(first.state, [coffee, coffee]).state).toHaveLength(2);
  });

  it("ett tredje likadant köp läggs till när det dyker upp", () => {
    const coffee = imported();
    const first = importInto([], [coffee, coffee]);
    expect(importInto(first.state, [coffee, coffee, coffee]).state).toHaveLength(3);
  });

  it("två bokförda köp med olika bank-id hålls isär även om de liknar varandra", () => {
    const first = importInto([], [imported({ providerTxId: "a", transactionDate: "2026-11-10" })]);
    const second = importInto(first.state, [imported({ providerTxId: "b", transactionDate: "2026-11-11" })]);
    expect(second.state).toHaveLength(2);
  });

  it("matchar på fingeravtryck inom ±3 dagar men inte längre bort", () => {
    const existing = [stored({ transactionDate: "2026-11-10" })];
    expect(importInto(existing, [imported({ transactionDate: "2026-11-13" })]).result.inserted).toHaveLength(0);
    expect(importInto(existing, [imported({ transactionDate: "2026-11-14" })]).result.inserted).toHaveLength(1);
  });

  it("matchar aldrig mellan olika konton, belopp eller motparter", () => {
    const existing = [stored()];
    for (const other of [{ accountId: "acc_2" }, { amountMinor: -4600 }, { counterpartyNorm: "pressbyrån" }]) {
      expect(importInto(existing, [imported(other)]).result.inserted).toHaveLength(1);
    }
  });

  it("CSV-rader utan bank-id dubbleras inte vid ny import (KK-10-B)", () => {
    const csv = [imported({ status: "booked" }), imported({ amountMinor: -129900, counterpartyNorm: "amex" })];
    const first = importInto([], csv);
    expect(importInto(first.state, csv).state).toHaveLength(2);
  });
});

describe("preliminär blir bokförd (KK-9-B)", () => {
  it("behåller id, byter status och tar bankens nya id och datum", () => {
    const pending = stored({ id: "tx_kept", status: "pending", providerTxId: "p1", bookingDate: null });
    const booked = imported({ providerTxId: "b9", transactionDate: "2026-11-11", bookingDate: "2026-11-12" });
    const { result, state } = importInto([pending], [booked]);

    expect(result.inserted).toEqual([]);
    expect(state).toEqual([
      { ...booked, id: "tx_kept", lastSeenOn: TODAY },
    ]);
  });

  it("fungerar även när banken saknar id", () => {
    const pending = stored({ id: "tx_kept", status: "pending", bookingDate: null });
    const { state } = importInto([pending], [imported({ transactionDate: "2026-11-12" })]);
    expect(state).toHaveLength(1);
    expect(state[0]).toMatchObject({ id: "tx_kept", status: "booked", transactionDate: "2026-11-12" });
  });

  it("två olika preliminära med olika id hålls isär", () => {
    const pending = stored({ status: "pending", providerTxId: "p1" });
    const { state } = importInto([pending], [imported({ status: "pending", providerTxId: "p2" })]);
    expect(state).toHaveLength(2);
  });

  it("en bokförd blir aldrig preliminär igen", () => {
    const booked = stored({ providerTxId: "b1" });
    const { state } = importInto([booked], [imported({ status: "pending", providerTxId: "b1" })]);
    expect(state).toEqual([{ ...booked, lastSeenOn: TODAY }]);
  });

  it("en preliminär som syns igen får nytt senast-sedd-datum", () => {
    const pending = stored({ status: "pending", providerTxId: "p1", lastSeenOn: "2026-11-15" });
    const { result } = importInto([pending], [imported({ status: "pending", providerTxId: "p1" })]);
    expect(result.updated).toEqual([{ ...pending, lastSeenOn: TODAY }]);
  });
});

describe("försvunnen preliminär (KK-9-C)", () => {
  it("markeras som borttagen när den saknats i mer än 10 dagar", () => {
    const pending = stored({ status: "pending", lastSeenOn: "2026-11-09" });
    expect(importInto([pending], []).result.updated).toEqual([{ ...pending, status: "removed" }]);
  });

  it("ligger kvar när den saknats i exakt 10 dagar", () => {
    const pending = stored({ status: "pending", lastSeenOn: "2026-11-10" });
    expect(importInto([pending], []).result.updated).toEqual([]);
  });

  it("bokförda transaktioner tas aldrig bort för att de saknas", () => {
    expect(importInto([stored({ lastSeenOn: "2026-01-01" })], []).result.updated).toEqual([]);
  });

  it("rör inte konton som inte hämtades i den här synken", () => {
    const pending = stored({ status: "pending", accountId: "acc_3", lastSeenOn: "2026-11-01" });
    expect(importInto([pending], []).result.updated).toEqual([]);
  });

  it("en borttagen som dyker upp igen blir aktiv igen", () => {
    const removed = stored({ id: "tx_back", status: "removed", lastSeenOn: "2026-11-01" });
    const { state } = importInto([removed], [imported()]);
    expect(state).toEqual([{ ...imported(), id: "tx_back", lastSeenOn: TODAY }]);
  });
});

describe("indata kontrolleras", () => {
  it("avvisar belopp som inte är heltal öre", () => {
    expect(() => importInto([], [imported({ amountMinor: 1.5 })])).toThrow(RangeError);
  });

  it("avvisar ogiltiga datum", () => {
    expect(() => importInto([], [imported({ transactionDate: "2026-11-31" })])).toThrow(RangeError);
  });
});

// Egenskapsbaserade tester (V-u-reconcile): slumpade men påhittade transaktioner.
// Bankens id identifierar en transaktion, så det härleds ur innehållet (eller saknas helt).
const arbImported = fc
  .record({
    accountId: fc.constantFrom("acc_1", "acc_2"),
    hasId: fc.boolean(),
    status: fc.constantFrom<"pending" | "booked">("pending", "booked"),
    transactionDate: fc.integer({ min: 1, max: 20 }).map((d) => `2026-11-${String(d).padStart(2, "0")}`),
    amountMinor: fc.constantFrom(-4500, -12900, 25000),
    counterpartyNorm: fc.constantFrom("ica", "sl", "espresso house"),
  })
  .map(({ hasId, ...tx }): ImportedTransaction => ({
    ...tx,
    providerTxId: hasId ? [tx.accountId, tx.status, tx.transactionDate, tx.amountMinor, tx.counterpartyNorm].join("/") : null,
    bookingDate: tx.status === "booked" ? tx.transactionDate : null,
  }));
const arbBatch = fc.array(arbImported, { maxLength: 12 });

/** Jämför tillstånd utan att bry sig om vilka nya id som genererades. */
const withoutIds = (state: readonly StoredTransaction[]) =>
  state.map((tx) => JSON.stringify({ ...tx, id: undefined })).sort();

describe("egenskaper", () => {
  it("att importera samma batch en gång till ändrar ingenting (idempotens)", () => {
    fc.assert(
      fc.property(arbBatch, arbBatch, (earlier, batch) => {
        const once = importInto(importInto([], earlier).state, batch).state;
        const twice = importInto(once, batch);
        expect(twice.result).toEqual({ inserted: [], updated: [] });
      }),
    );
  });

  it("ordningen i bankens svar påverkar inte resultatet", () => {
    fc.assert(
      fc.property(arbBatch, arbBatch.chain((b) => fc.tuple(fc.constant(b), fc.shuffledSubarray(b, { minLength: b.length }))), (earlier, [batch, shuffled]) => {
        const base = importInto([], earlier).state;
        expect(withoutIds(importInto(base, batch).state)).toEqual(withoutIds(importInto(base, shuffled).state));
      }),
    );
  });

  it("varje transaktion i en batch finns exakt en gång, hur många gånger den än importeras", () => {
    fc.assert(
      fc.property(arbBatch, fc.integer({ min: 1, max: 4 }), (batch, times) => {
        let state: StoredTransaction[] = [];
        for (let i = 0; i < times; i++) state = importInto(state, batch, { newId: counter(`r${String(i)}`) }).state;
        expect(state.filter((tx) => tx.status !== "removed")).toHaveLength(batch.length);
      }),
    );
  });

  it("befintliga id försvinner aldrig, så kategori och uppdelning följer med", () => {
    fc.assert(
      fc.property(arbBatch, arbBatch, (earlier, batch) => {
        const before = importInto([], earlier).state;
        const after = importInto(before, batch).state;
        const ids = new Set(after.map((tx) => tx.id));
        expect(before.every((tx) => ids.has(tx.id))).toBe(true);
        expect(ids.size).toBe(after.length);
      }),
    );
  });
});
