import { describe, expect, it } from "vitest";
import { ProviderError, type BankAccount, type BankDataProvider, type ProviderTransaction, type TransactionPage } from "./bank.ts";
import { runProviderContract } from "./provider-contract.ts";

const ACCOUNT: BankAccount = { providerUid: "uid-1", iban: null, name: "Testkonto", type: "checking", currency: "SEK" };

function tx(overrides: Partial<ProviderTransaction> = {}): ProviderTransaction {
  return {
    providerTxId: "t1",
    status: "booked",
    transactionDate: "2026-10-02",
    bookingDate: "2026-10-03",
    amountMinor: -4500,
    counterparty: "Fiktiv Butik AB",
    description: "Kortköp",
    ...overrides,
  };
}

/** En leverantör med påhittade svar. Sidorna lämnas ut i ordning, per konto. */
function fakeProvider(options: { accounts?: BankAccount[]; balance?: number | null; pages?: TransactionPage[] } = {}) {
  const steps: string[] = [];
  const queries: { dateFrom: string | null; continuationKey: string | null }[] = [];
  const pages = options.pages ?? [{ transactions: [tx()], continuationKey: null }];
  const provider: BankDataProvider = {
    accounts: () => Promise.resolve(options.accounts ?? [ACCOUNT]),
    balance: () => Promise.resolve(options.balance === undefined ? 10000 : options.balance),
    transactions(_uid, query) {
      queries.push(query);
      return Promise.resolve(pages[Math.min(queries.length - 1, pages.length - 1)] ?? { transactions: [], continuationKey: null });
    },
  };
  return { provider, steps, queries, onStep: (step: string) => steps.push(step) };
}

describe("kontraktssviten för BankDataProvider (KK-14-B, V-c-provider)", () => {
  it("en leverantör som följer porten klarar sviten och ger en sammanfattning utan bankdata", async () => {
    const { provider, queries } = fakeProvider({
      pages: [
        { transactions: [tx({ description: "x".repeat(140) }), tx({ providerTxId: null, status: "pending", bookingDate: null, transactionDate: "2026-09-01" })], continuationKey: "k2" },
        { transactions: [tx({ providerTxId: "t2", amountMinor: 120000 })], continuationKey: null },
      ],
    });
    expect(await runProviderContract(provider, "s1")).toEqual({
      accounts: [{ type: "checking", hasBalance: true, pages: 2, booked: 2, pending: 1, oldest: "2026-09-01" }],
      failures: [],
    });
    expect(queries).toEqual([
      { dateFrom: null, continuationKey: null },
      { dateFrom: null, continuationKey: "k2" },
    ]);
  });

  it("ett konto utan saldo och utan transaktioner är tillåtet", async () => {
    const { provider } = fakeProvider({ balance: null, pages: [{ transactions: [], continuationKey: null }] });
    expect(await runProviderContract(provider, "s1")).toEqual({
      accounts: [{ type: "checking", hasBalance: false, pages: 1, booked: 0, pending: 0, oldest: null }],
      failures: [],
    });
  });

  it.each([
    ["belopp noll", tx({ amountMinor: 0 }), "beloppet är heltal öre och inte noll"],
    ["belopp i kronor", tx({ amountMinor: 45.5 }), "beloppet är heltal öre och inte noll"],
    ["fel datumformat", tx({ transactionDate: "2026-10-2" }), "transaktionsdatum är YYYY-MM-DD"],
    ["text efter datumet", tx({ transactionDate: "2026-10-02T10:00" }), "transaktionsdatum är YYYY-MM-DD"],
    ["text före datumet", tx({ transactionDate: "den 2026-10-02" }), "transaktionsdatum är YYYY-MM-DD"],
    ["bokförd utan bokföringsdatum", tx({ bookingDate: null }), "en bokförd transaktion har bokföringsdatum"],
    ["för lång beskrivning", tx({ description: "x".repeat(141) }), "beskrivningen är högst 140 tecken"],
  ])("upptäcker %s", async (_, row, rule) => {
    const { provider } = fakeProvider({ pages: [{ transactions: [row], continuationKey: null }] });
    expect((await runProviderContract(provider, "s1")).failures).toEqual([rule]);
  });

  it("upptäcker id som inte är unika, saldo som inte är heltal och konto utan uid", async () => {
    const { provider } = fakeProvider({ accounts: [{ ...ACCOUNT, providerUid: "" }], balance: 1.5, pages: [{ transactions: [tx(), tx()], continuationKey: null }] });
    expect((await runProviderContract(provider, "s1")).failures).toEqual(["kontot har ett uid", "saldot är heltal öre", "bankens id är unika inom kontot"]);
  });

  it("samma regel listas en gång även när många rader bryter mot den", async () => {
    const zero = tx({ providerTxId: null, amountMinor: 0 });
    const { provider } = fakeProvider({ pages: [{ transactions: [zero, zero, zero], continuationKey: null }] });
    expect((await runProviderContract(provider, "s1")).failures).toEqual(["beloppet är heltal öre och inte noll"]);
  });

  it("upptäcker en session utan konton", async () => {
    const { provider } = fakeProvider({ accounts: [] });
    expect(await runProviderContract(provider, "s1")).toEqual({ accounts: [], failures: ["sessionen har minst ett konto"] });
  });

  it("upptäcker en continuation key som inte byts och en historik som aldrig tar slut", async () => {
    const { provider, queries } = fakeProvider({ pages: [{ transactions: [], continuationKey: "samma" }] });
    const { failures, accounts } = await runProviderContract(provider, "s1", { maxPages: 4 });
    expect(failures).toEqual(["continuation key byts mellan sidor", "historiken tar slut inom 4 sidor"]);
    expect(queries).toHaveLength(4);
    expect(accounts[0]?.pages).toBe(4);
  });

  it("berättar vilket steg som pågår, så att ett fel går att felsöka, och släpper igenom bankens fel", async () => {
    const { provider, steps, onStep } = fakeProvider({ accounts: [ACCOUNT, { ...ACCOUNT, providerUid: "uid-2" }] });
    await runProviderContract(provider, "s1", { onStep });
    expect(steps).toEqual(["sessionen och kontona", "saldo för konto 1", "transaktioner för konto 1", "saldo för konto 2", "transaktioner för konto 2"]);

    const failing: BankDataProvider = { ...provider, balance: () => Promise.reject(new ProviderError("UNAUTHORIZED")) };
    await expect(runProviderContract(failing, "s1")).rejects.toEqual(new ProviderError("UNAUTHORIZED"));
  });
});
