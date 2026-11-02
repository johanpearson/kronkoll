import { describe, expect, it } from "vitest";
import {
  ProviderError,
  type BankDataProvider,
  type ProviderTransaction,
  type TransactionPage,
} from "./bank.ts";
import type { ReconcileResult, StoredTransaction } from "./reconcile.ts";
import { syncAccount, type TransactionStore } from "./sync-account.ts";

const TODAY = "2026-11-20";
const ACCOUNT = { id: "acc_1", providerUid: "uid-1" };

let sequence = 0;
const newId = () => `tx_${String(++sequence)}`;

function bankTx(overrides: Partial<ProviderTransaction> = {}): ProviderTransaction {
  return {
    providerTxId: null,
    status: "booked",
    transactionDate: "2026-11-10",
    bookingDate: "2026-11-10",
    amountMinor: -4500,
    counterparty: "K*ESPRESSO HOUSE 123 STHLM",
    description: "Kaffe",
    ...overrides,
  };
}

/** En minnesbaserad lagring som gör det som D1-repositoryt gör. */
function memoryStore(initial: StoredTransaction[] = []) {
  const state = { rows: [...initial], saves: 0, reads: [] as { accountIds: readonly string[]; dateFrom: string | null }[] };
  const store: TransactionStore = {
    forReconcile(accountIds, dateFrom) {
      state.reads.push({ accountIds, dateFrom });
      return Promise.resolve(state.rows.filter((r) => accountIds.includes(r.accountId)));
    },
    save(result: ReconcileResult) {
      state.saves += 1;
      const updated = new Map(result.updated.map((r) => [r.id, r]));
      state.rows = [...state.rows.map((r) => updated.get(r.id) ?? r), ...result.inserted];
      return Promise.resolve();
    },
    latestBookedDate(accountId) {
      const dates = state.rows.filter((r) => r.accountId === accountId && r.status === "booked").map((r) => r.bookingDate ?? "");
      return Promise.resolve(dates.length === 0 ? null : dates.sort().at(-1) ?? null);
    },
  };
  return { store, state };
}

/** En bank som svarar med sidor i ordning och minns vilka frågor den fick. */
function fakeBank(pages: (TransactionPage | ProviderError)[]) {
  const calls: { accountUid: string; dateFrom: string; continuationKey: string | null }[] = [];
  const provider: BankDataProvider = {
    accounts: () => Promise.resolve([]),
    balance: () => Promise.resolve(null),
    transactions(accountUid, query) {
      calls.push({ accountUid, ...query });
      const page = pages[calls.length - 1];
      if (page === undefined) return Promise.reject(new Error("Fler sidor än väntat"));
      return page instanceof ProviderError ? Promise.reject(page) : Promise.resolve(page);
    },
  };
  return { provider, calls };
}

const onePage = (transactions: ProviderTransaction[]): TransactionPage => ({ transactions, continuationKey: null });

function run(bank: BankDataProvider, store: TransactionStore, options: { today?: string; maxPages?: number } = {}) {
  return syncAccount({ provider: bank, store, account: ACCOUNT, today: options.today ?? TODAY, newId, ...(options.maxPages === undefined ? {} : { maxPages: options.maxPages }) });
}

describe("hämta, stäm av och spara ett konto (KK-7-A)", () => {
  it("första gången hämtas 90 dagar bakåt och alla sidor följs", async () => {
    const { store, state } = memoryStore();
    const bank = fakeBank([
      { transactions: [bankTx({ providerTxId: "a" })], continuationKey: "k2" },
      onePage([bankTx({ providerTxId: "b", amountMinor: -9900 })]),
    ]);
    expect(await run(bank.provider, store)).toEqual({ ok: true, newCount: 2, updatedCount: 0 });
    expect(bank.calls).toEqual([
      { accountUid: "uid-1", dateFrom: "2026-08-22", continuationKey: null },
      { accountUid: "uid-1", dateFrom: "2026-08-22", continuationKey: "k2" },
    ]);
    expect(state.rows).toHaveLength(2);
    expect(state.saves).toBe(1);
  });

  it("senare hämtningar börjar 10 dagar före senaste bokförda och läser lagringen från samma datum", async () => {
    const { store, state } = memoryStore();
    await run(fakeBank([onePage([bankTx({ providerTxId: "a" })])]).provider, store);
    const bank = fakeBank([onePage([bankTx({ providerTxId: "a" })])]);
    await run(bank.provider, store, { today: "2026-11-21" });
    expect(bank.calls[0]?.dateFrom).toBe("2026-10-31");
    expect(state.reads.at(-1)).toEqual({ accountIds: ["acc_1"], dateFrom: "2026-10-31" });
  });

  it("samma data en gång till samma dag ändrar ingenting", async () => {
    const { store } = memoryStore();
    const page = onePage([bankTx({ providerTxId: "a" })]);
    await run(fakeBank([page]).provider, store);
    expect(await run(fakeBank([page]).provider, store)).toEqual({ ok: true, newCount: 0, updatedCount: 0 });
  });

  it("sparar motparten som banken skickade den och normaliserar den för matchning", async () => {
    const { store, state } = memoryStore();
    await run(fakeBank([onePage([bankTx({ providerTxId: "a" })])]).provider, store);
    expect(state.rows[0]).toMatchObject({ accountId: "acc_1", counterparty: "K*ESPRESSO HOUSE 123 STHLM", counterpartyNorm: "ESPRESSO HOUSE", description: "Kaffe" });
  });

  it("begränsar beskrivningen till 140 tecken", async () => {
    const { store, state } = memoryStore();
    await run(fakeBank([onePage([bankTx({ providerTxId: "a", description: "x".repeat(300) })])]).provider, store);
    expect(state.rows[0]?.description).toHaveLength(140);
  });

  it("en preliminär som bokförs med lite annat belopp blir samma rad (20 %)", async () => {
    const { store, state } = memoryStore();
    await run(fakeBank([onePage([bankTx({ status: "pending", providerTxId: "p", bookingDate: null, amountMinor: -10000 })])]).provider, store);
    const id = state.rows[0]?.id;
    const result = await run(fakeBank([onePage([bankTx({ providerTxId: "b", amountMinor: -11000 })])]).provider, store);
    expect(result).toEqual({ ok: true, newCount: 0, updatedCount: 1 });
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]).toMatchObject({ id, status: "booked", amountMinor: -11000 });
  });

  it("en preliminär som banken slutat skicka markeras som borttagen efter 10 dagar", async () => {
    const old: StoredTransaction = {
      id: "tx_old",
      accountId: "acc_1",
      providerTxId: "p",
      status: "pending",
      transactionDate: "2026-11-01",
      bookingDate: null,
      amountMinor: -700,
      counterpartyNorm: "KIOSK",
      counterparty: "KIOSK",
      description: "",
      lastSeenOn: "2026-11-02",
    };
    const { store, state } = memoryStore([old]);
    expect(await run(fakeBank([onePage([])]).provider, store)).toEqual({ ok: true, newCount: 0, updatedCount: 1 });
    expect(state.rows[0]?.status).toBe("removed");
  });
});

describe("fel isoleras och lämnar inget halvt resultat (KK-7-B)", () => {
  it.each(["UNAUTHORIZED", "RATE_LIMITED", "UNAVAILABLE", "BAD_RESPONSE", "FAILED"] as const)("bankfel %s ger ett misslyckat resultat och ingenting sparas", async (code) => {
    const { store, state } = memoryStore();
    expect(await run(fakeBank([new ProviderError(code)]).provider, store)).toEqual({ ok: false, error: code });
    expect(state.saves).toBe(0);
  });

  it("om sidan två misslyckas sparas inte heller sidan ett", async () => {
    const { store, state } = memoryStore();
    const bank = fakeBank([{ transactions: [bankTx({ providerTxId: "a" })], continuationKey: "k2" }, new ProviderError("RATE_LIMITED")]);
    expect(await run(bank.provider, store)).toEqual({ ok: false, error: "RATE_LIMITED" });
    expect(state.rows).toEqual([]);
  });

  it("ett oväntat fel, till exempel från lagringen, blir FAILED utan att texten följer med", async () => {
    const { store } = memoryStore();
    const failing: TransactionStore = { ...store, save: () => Promise.reject(new Error("konto 1234 är spärrat")) };
    const result = await run(fakeBank([onePage([bankTx({ providerTxId: "a" })])]).provider, failing);
    expect(result).toEqual({ ok: false, error: "FAILED" });
    expect(JSON.stringify(result)).not.toContain("1234");
  });

  it("fler sidor än gränsen räknas som misslyckat, så att en avkortad hämtning aldrig markerar preliminära som borttagna", async () => {
    const { store, state } = memoryStore();
    const endless = fakeBank(Array.from({ length: 5 }, (_, i) => ({ transactions: [bankTx({ providerTxId: `t${String(i)}` })], continuationKey: `k${String(i)}` })));
    expect(await run(endless.provider, store, { maxPages: 3 })).toEqual({ ok: false, error: "FAILED" });
    expect(endless.calls).toHaveLength(3);
    expect(state.saves).toBe(0);
  });
});
