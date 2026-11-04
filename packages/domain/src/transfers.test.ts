import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  classifyTransfers,
  excludeRuleHits,
  type ExcludeRule,
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
    description: "",
    status: "booked",
    manualTransfer: null,
    ...overrides,
  };
}

function classify(transactions: TransferInput[], cardPayees = CARD_PAYEES) {
  const result = classifyTransfers({ transactions, accounts: ACCOUNTS, cardPaymentCounterparties: cardPayees, excludeRules: [] });
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

describe("regler med åtgärden Räkna inte (KK-39-C, V-u-exclude)", () => {
  const MOBLER: ExcludeRule = { id: "r-mobler", match: "counterparty_prefix", pattern: "PAHITTADE MOBLER" };
  const withRules = (transactions: TransferInput[], rules: ExcludeRule[]) =>
    Object.fromEntries(classifyTransfers({ transactions, accounts: ACCOUNTS, cardPaymentCounterparties: CARD_PAYEES, excludeRules: rules }).map((c) => [c.id, c]));

  it("en transaktion som regeln träffar räknas inte, oavsett tecken", () => {
    const result = withRules(
      [tx({ id: "köp", counterpartyNorm: "PAHITTADE MOBLER AB", amountMinor: -129900 }), tx({ id: "retur", counterpartyNorm: "PAHITTADE MOBLER AB", amountMinor: 129900 }), tx({ id: "annat", counterpartyNorm: "HORNBUTIKEN", amountMinor: -4500 })],
      [MOBLER],
    );
    expect(result.köp).toEqual({ id: "köp", internal: true, pairId: null, reason: "rule" });
    expect(result.retur).toMatchObject(internal(null, "rule"));
    expect(result.annat).toMatchObject(external);
  });

  it("matchar på beskrivningen när banken inte skickar motpart, som kategoriregler", () => {
    const rules: ExcludeRule[] = [MOBLER, { id: "r-text", match: "description_contains", pattern: "UTLÄGG" }];
    const result = withRules([tx({ id: "kort", description: "PAHITTADE MOBLER 12, STOCKHOLM", amountMinor: -4500 }), tx({ id: "text", counterpartyNorm: "NÅGON", description: "utlägg resa", amountMinor: -4500 })], rules);
    expect(result.kort).toMatchObject(internal(null, "rule"));
    expect(result.text).toMatchObject(internal(null, "rule"));
  });

  it("ett eget val vinner över regeln, åt båda hållen", () => {
    const result = withRules([tx({ id: "räkna", counterpartyNorm: "PAHITTADE MOBLER", manualTransfer: false }), tx({ id: "inte", counterpartyNorm: "PAHITTADE MOBLER", manualTransfer: true })], [MOBLER]);
    expect(result.räkna).toMatchObject({ internal: false, reason: "manual" });
    expect(result.inte).toMatchObject(internal(null, "manual"));
  });

  it("ett par förblir ett par, och borttagna eller okända konton markeras inte", () => {
    const result = withRules(
      [tx({ id: "ut", counterpartyNorm: "PAHITTADE MOBLER" }), tx({ id: "in", accountId: "spar", amountMinor: 500000 }), tx({ id: "borta", counterpartyNorm: "PAHITTADE MOBLER", status: "removed", amountMinor: -1 }), tx({ id: "främmande", accountId: "okänt", counterpartyNorm: "PAHITTADE MOBLER", amountMinor: -2 })],
      [MOBLER],
    );
    expect(result.ut).toMatchObject(internal("in", "pair"));
    expect(result.borta).toMatchObject(external);
    expect(result.främmande).toMatchObject(external);
  });

  it("utan regler är allt som förut, och en borttagen regel släpper sina träffar", () => {
    const batch = [tx({ id: "köp", counterpartyNorm: "PAHITTADE MOBLER", amountMinor: -4500 })];
    expect(withRules(batch, []).köp).toMatchObject(external);
    expect(classify(batch).köp).toMatchObject(external);
  });

  it("räknar hur många transaktioner varje regel träffar, egna val inräknade men inte borttagna", () => {
    const rules: ExcludeRule[] = [MOBLER, { id: "r-tom", match: "counterparty_exact", pattern: "INGEN" }];
    const hits = excludeRuleHits(
      [tx({ id: "a", counterpartyNorm: "PAHITTADE MOBLER" }), tx({ id: "b", counterpartyNorm: "PAHITTADE MOBLER AB", manualTransfer: false }), tx({ id: "c", counterpartyNorm: "ANNAT" }), tx({ id: "d", counterpartyNorm: "PAHITTADE MOBLER", status: "removed" })],
      rules,
    );
    expect(hits).toEqual(new Map([["r-mobler", 2]]));
  });

  it("när flera regler träffar räknas den mest precisa: exakt, sedan längst mönster, sedan id", () => {
    const rules: ExcludeRule[] = [
      { id: "b-kort", match: "counterparty_prefix", pattern: "PAHITTADE" },
      { id: "c-lang", match: "counterparty_prefix", pattern: "PAHITTADE MOBLER" },
      { id: "d-exakt", match: "counterparty_exact", pattern: "PAHITTADE MOBLER" },
      { id: "e-text", match: "description_contains", pattern: "MÖBLER" },
      { id: "a-text", match: "description_contains", pattern: "MÖBLER" },
    ];
    const hits = excludeRuleHits(
      [tx({ id: "x", counterpartyNorm: "PAHITTADE MOBLER" }), tx({ id: "y", counterpartyNorm: "PAHITTADE MOBLER AB" }), tx({ id: "z", counterpartyNorm: "PAHITTADE LAMPOR" }), tx({ id: "w", counterpartyNorm: "ANNAT", description: "köp möbler" })],
      rules,
    );
    expect(hits).toEqual(new Map([["d-exakt", 1], ["c-lang", 1], ["b-kort", 1], ["a-text", 1]]));
    // Samma svar oavsett i vilken ordning reglerna kommer från databasen.
    expect(excludeRuleHits([tx({ id: "w", counterpartyNorm: "ANNAT", description: "köp möbler" })], [...rules].reverse())).toEqual(new Map([["a-text", 1]]));
  });
});

// Egenskaper: påhittade transaktioner på de egna kontona och ett okänt konto.
const arbTx = fc.record({
  accountId: fc.constantFrom("privat", "spar", "visa", "okänt"),
  transactionDate: fc.integer({ min: 1, max: 12 }).map((d) => `2026-11-${String(d).padStart(2, "0")}`),
  amountMinor: fc.constantFrom(-500000, 500000, -4500, 4500),
  counterpartyNorm: fc.constantFrom("", "skandia visa", "ica"),
  description: fc.constantFrom("", "ICA KVITTO"),
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

  it("en regel som Räkna inte gör aldrig något internt externt, och rör aldrig ett eget val (KK-39-C)", () => {
    const rules: ExcludeRule[] = [{ id: "r-ica", match: "counterparty_prefix", pattern: "ica" }];
    fc.assert(
      fc.property(arbBatch, (batch) => {
        const before = classify(batch);
        const after = Object.fromEntries(classifyTransfers({ transactions: batch, accounts: ACCOUNTS, cardPaymentCounterparties: CARD_PAYEES, excludeRules: rules }).map((c) => [c.id, c]));
        for (const t of batch) {
          if (before[t.id]?.internal === true) expect(after[t.id]).toEqual(before[t.id]);
          if (t.manualTransfer !== null) expect(after[t.id]?.reason).toBe("manual");
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
