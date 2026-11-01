import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  classifyTransfers,
  type OwnAccount,
  type TransferClassification,
  type TransferInput,
} from "./transfers.ts";

const ACCOUNTS: OwnAccount[] = [
  { id: "privat", type: "checking" },
  { id: "spar", type: "savings" },
  { id: "visa", type: "credit_card" },
];
const CARD_PAYEES = ["skandia visa"];

function tx(overrides: Partial<TransferInput> & { id: string }): TransferInput {
  return {
    accountId: "privat",
    transactionDate: "2026-11-10",
    amountMinor: -500000,
    counterpartyNorm: "",
    status: "booked",
    manualTransfer: null,
    ...overrides,
  };
}

function classify(transactions: TransferInput[], cardPayees = CARD_PAYEES) {
  const result = classifyTransfers({ transactions, accounts: ACCOUNTS, cardPaymentCounterparties: cardPayees });
  return Object.fromEntries(result.map((c) => [c.id, c]));
}

const internal = (pairId: string | null, reason: TransferClassification["reason"]) => ({
  internal: true,
  pairId,
  reason,
});
const external = { internal: false, pairId: null, reason: "none" };

describe("överföringar mellan egna konton (KK-20-C, V-u-transfers)", () => {
  it("−5 000 kr från privatkontot och +5 000 kr på sparkontot samma dag är ett par", () => {
    const result = classify([tx({ id: "ut" }), tx({ id: "in", accountId: "spar", amountMinor: 500000 })]);
    expect(result.ut).toMatchObject(internal("in", "pair"));
    expect(result.in).toMatchObject(internal("ut", "pair"));
  });

  it("paret får skilja upp till 3 dagar, men inte 4", () => {
    const three = classify([tx({ id: "ut" }), tx({ id: "in", accountId: "spar", amountMinor: 500000, transactionDate: "2026-11-13" })]);
    expect(three.ut?.internal).toBe(true);
    const four = classify([tx({ id: "ut" }), tx({ id: "in", accountId: "spar", amountMinor: 500000, transactionDate: "2026-11-14" })]);
    expect(four.ut).toMatchObject(external);
  });

  it("kräver exakt motsatt belopp", () => {
    const result = classify([tx({ id: "ut" }), tx({ id: "in", accountId: "spar", amountMinor: 499900 })]);
    expect(result.ut).toMatchObject(external);
  });

  it("två transaktioner på samma konto är aldrig en överföring", () => {
    const result = classify([tx({ id: "ut" }), tx({ id: "in", amountMinor: 500000 })]);
    expect(result.ut).toMatchObject(external);
  });

  it("ett konto som inte är vårt kan inte vara den andra halvan", () => {
    const result = classify([tx({ id: "ut" }), tx({ id: "in", accountId: "okänt", amountMinor: 500000 })]);
    expect(result.ut).toMatchObject(external);
  });

  it("varje transaktion ingår i högst ett par, och närmast i datum vinner", () => {
    const result = classify([
      tx({ id: "ut" }),
      tx({ id: "in-far", accountId: "spar", amountMinor: 500000, transactionDate: "2026-11-12" }),
      tx({ id: "in-near", accountId: "spar", amountMinor: 500000, transactionDate: "2026-11-11" }),
    ]);
    expect(result.ut).toMatchObject(internal("in-near", "pair"));
    expect(result["in-far"]).toMatchObject(external);
  });

  it("borttagna preliminära räknas inte", () => {
    const result = classify([tx({ id: "ut" }), tx({ id: "in", accountId: "spar", amountMinor: 500000, status: "removed" })]);
    expect(result.ut).toMatchObject(external);
    expect(result.in).toMatchObject(external);
  });
});

describe("kortfakturan (KK-20-C)", () => {
  it("betalning till Visa-kontot är ett vanligt par", () => {
    const result = classify([
      tx({ id: "betalning", counterpartyNorm: "skandia visa" }),
      tx({ id: "inbetalning", accountId: "visa", amountMinor: 500000 }),
    ]);
    expect(result.betalning).toMatchObject(internal("inbetalning", "pair"));
  });

  it("betalning till en känd kortmottagare är intern även utan motpost", () => {
    const result = classify([tx({ id: "betalning", counterpartyNorm: "skandia visa" })]);
    expect(result.betalning).toMatchObject(internal(null, "card_payment"));
  });

  it("gäller inte köp med kortet, och inte insättningar till kortmottagaren", () => {
    const result = classify([
      tx({ id: "köp", accountId: "visa", counterpartyNorm: "skandia visa", amountMinor: -4500 }),
      tx({ id: "insättning", counterpartyNorm: "skandia visa", amountMinor: 500000 }),
    ]);
    expect(result.köp).toMatchObject(external);
    expect(result.insättning).toMatchObject(external);
  });

  it("en insättning på kortkontot utan motpost kan vara en återbetalning och räknas inte som intern", () => {
    const result = classify([tx({ id: "retur", accountId: "visa", counterpartyNorm: "elgiganten", amountMinor: 129900 })]);
    expect(result.retur).toMatchObject(external);
  });

  it("utan konfigurerade kortmottagare blir en ensam betalning en vanlig utgift", () => {
    const result = classify([tx({ id: "betalning", counterpartyNorm: "skandia visa" })], []);
    expect(result.betalning).toMatchObject(external);
  });
});

describe("manuell markering vinner (KK-20-C)", () => {
  it("\"inte en överföring\" bryter ett automatiskt par, och den andra halvan blir fri", () => {
    const result = classify([
      tx({ id: "ut", manualTransfer: false }),
      tx({ id: "in", accountId: "spar", amountMinor: 500000 }),
    ]);
    expect(result.ut).toMatchObject({ internal: false, pairId: null, reason: "manual" });
    expect(result.in).toMatchObject(external);
  });

  it("\"inte en överföring\" vinner över kortmottagaren", () => {
    const result = classify([tx({ id: "betalning", counterpartyNorm: "skandia visa", manualTransfer: false })]);
    expect(result.betalning).toMatchObject({ internal: false, reason: "manual" });
  });

  it("\"är en överföring\" gäller även utan motpost", () => {
    const result = classify([tx({ id: "swish-till-mig-själv", manualTransfer: true })]);
    expect(result["swish-till-mig-själv"]).toMatchObject(internal(null, "manual"));
  });
});

describe("indata kontrolleras", () => {
  it("avvisar belopp som inte är heltal öre och ogiltiga datum", () => {
    expect(() => classify([tx({ id: "a", amountMinor: 1.5 })])).toThrow(RangeError);
    expect(() => classify([tx({ id: "a", transactionDate: "2026-02-30" })])).toThrow(RangeError);
  });
});

// Egenskaper: påhittade transaktioner på de egna kontona och ett okänt konto.
const arbTx = fc.record({
  accountId: fc.constantFrom("privat", "spar", "visa", "okänt"),
  transactionDate: fc.integer({ min: 1, max: 12 }).map((d) => `2026-11-${String(d).padStart(2, "0")}`),
  amountMinor: fc.constantFrom(-500000, 500000, -4500, 4500),
  counterpartyNorm: fc.constantFrom("", "skandia visa", "ica"),
  status: fc.constantFrom<TransferInput["status"]>("pending", "booked", "removed"),
  manualTransfer: fc.constantFrom<boolean | null>(null, null, null, true, false),
});
const arbBatch = fc.array(arbTx, { maxLength: 14 }).map((list) => list.map((t, i) => ({ ...t, id: `t${String(i)}` })));

describe("egenskaper", () => {
  it("par är ömsesidiga, går mellan olika egna konton och tar ut varandra", () => {
    fc.assert(
      fc.property(arbBatch, (batch) => {
        const byId = classify(batch);
        const input = Object.fromEntries(batch.map((t) => [t.id, t]));
        for (const c of Object.values(byId)) {
          if (c.pairId === null) continue;
          const other = byId[c.pairId];
          expect(other?.pairId).toBe(c.id);
          expect(input[c.id]?.accountId).not.toBe(input[c.pairId]?.accountId);
          expect((input[c.id]?.amountMinor ?? 0) + (input[c.pairId]?.amountMinor ?? 1)).toBe(0);
        }
      }),
    );
  });

  it("en manuell markering följs alltid", () => {
    fc.assert(
      fc.property(arbBatch, (batch) => {
        const byId = classify(batch);
        for (const t of batch) {
          if (t.manualTransfer !== null) expect(byId[t.id]?.internal).toBe(t.manualTransfer);
        }
      }),
    );
  });

  it("ordningen påverkar inte resultatet", () => {
    fc.assert(
      fc.property(arbBatch.chain((b) => fc.tuple(fc.constant(b), fc.shuffledSubarray(b, { minLength: b.length }))), ([batch, shuffled]) => {
        expect(classify(shuffled)).toEqual(classify(batch));
      }),
    );
  });
});
