import { describe, expect, it } from "vitest";
import { ProviderError, type BankDataProvider, type ProviderTransaction } from "./bank.ts";
import { fixedClock } from "./clock.ts";
import type { ConnectionStatus } from "./consent.ts";
import type { ReconcileResult, StoredTransaction } from "./reconcile.ts";
import type { TransactionStore } from "./sync-account.ts";
import { syncConnection, type SyncConnectionInput } from "./sync-connection.ts";
import { nextConsecutiveFailures, type SyncRunSummary } from "./sync.ts";

const NOW = "2026-11-20T04:07:00.000Z";
const A1 = { id: "acc_1", providerUid: "uid-1" };
const A2 = { id: "acc_2", providerUid: "uid-2" };

let sequence = 0;
const newId = () => `id_${String(++sequence)}`;

function bankTx(overrides: Partial<ProviderTransaction> = {}): ProviderTransaction {
  return {
    providerTxId: null,
    status: "booked",
    transactionDate: "2026-11-10",
    bookingDate: "2026-11-10",
    amountMinor: -4500,
    counterparty: "ESPRESSO HOUSE",
    description: "",
    ...overrides,
  };
}

type Behaviour = { transactions: ProviderTransaction[] | ProviderError; balance?: number | null | ProviderError };

/** Banken svarar per konto-uid, så att fel kan riktas mot ett enda konto. */
function fakeBank(perAccount: Record<string, Behaviour>) {
  const calls: string[] = [];
  const provider: BankDataProvider = {
    accounts: () => Promise.resolve([]),
    balance(uid) {
      calls.push(`balance:${uid}`);
      const b = perAccount[uid]?.balance;
      if (b instanceof ProviderError) return Promise.reject(b);
      return Promise.resolve(b === undefined ? 100000 : b);
    },
    transactions(uid) {
      calls.push(`transactions:${uid}`);
      const t = perAccount[uid]?.transactions ?? [];
      return t instanceof ProviderError ? Promise.reject(t) : Promise.resolve({ transactions: t, continuationKey: null });
    },
  };
  return { provider, calls };
}

function setup(options: { connection?: { status?: ConnectionStatus; consentExpiresOn?: string | null }; failuresBefore?: number; bank?: Record<string, Behaviour> } = {}) {
  const rows: StoredTransaction[] = [];
  const events: string[] = [];
  const runs = new Map<string, { startedAt: string; kind: string; finishedAt?: string; summary?: SyncRunSummary }>();
  const balances = new Map<string, number>();
  let failures = options.failuresBefore ?? 0;
  const store: TransactionStore = {
    forReconcile: (ids) => Promise.resolve(rows.filter((r) => ids.includes(r.accountId))),
    save(result: ReconcileResult) {
      rows.push(...result.inserted);
      return Promise.resolve();
    },
    latestBookedDate: () => Promise.resolve(null),
  };
  const bank = fakeBank(options.bank ?? {});
  const input: SyncConnectionInput = {
    connection: { id: "c1", status: options.connection?.status ?? "active", consentExpiresOn: options.connection?.consentExpiresOn ?? "2027-04-30" },
    accounts: [A1, A2],
    kind: "cron",
    provider: bank.provider,
    store,
    runs: {
      start(run) {
        events.push("run:start");
        runs.set(run.id, { startedAt: run.startedAt, kind: run.kind });
        return Promise.resolve();
      },
      finish(id, finishedAt, summary) {
        events.push("run:finish");
        const run = runs.get(id);
        if (run) Object.assign(run, { finishedAt, summary });
        return Promise.resolve();
      },
    },
    connections: {
      recordSyncOutcome(_id, status) {
        events.push(`outcome:${status}`);
        failures = nextConsecutiveFailures(failures, status);
        return Promise.resolve(failures);
      },
      expire() {
        events.push("expire");
        return Promise.resolve();
      },
    },
    balances: {
      setBalance(accountId, balanceMinor) {
        balances.set(accountId, balanceMinor);
        return Promise.resolve();
      },
    },
    clock: fixedClock(NOW),
    newId,
  };
  return { input, rows, events, runs, balances, bank };
}

describe("synk av en koppling (KK-7-A)", () => {
  it("hämtar alla konton, sparar saldon och loggar körningen med antal", async () => {
    const t = setup({ bank: { "uid-1": { transactions: [bankTx({ providerTxId: "a" })], balance: 125000 }, "uid-2": { transactions: [bankTx({ providerTxId: "b", amountMinor: -900 })], balance: -3200 } } });
    const outcome = await syncConnection(t.input);
    expect(outcome).toMatchObject({ skipped: false, summary: { status: "ok", newCount: 2, updatedCount: 0, errorCode: null }, consentExpired: false, notifyFailure: false });
    expect(t.balances).toEqual(new Map([["acc_1", 125000], ["acc_2", -3200]]));
    expect(t.events).toEqual(["run:start", "run:finish", "outcome:ok"]);
    const [run] = [...t.runs.values()];
    expect(run).toMatchObject({ kind: "cron", startedAt: NOW, finishedAt: NOW, summary: { status: "ok" } });
  });

  it("ett saldo som banken inte ger lämnar det gamla saldot orört", async () => {
    const t = setup({ bank: { "uid-1": { transactions: [], balance: null }, "uid-2": { transactions: [], balance: 5 } } });
    await syncConnection(t.input);
    expect(t.balances).toEqual(new Map([["acc_2", 5]]));
  });

  it("en koppling utan konton är ok", async () => {
    const t = setup();
    const outcome = await syncConnection({ ...t.input, accounts: [] });
    expect(outcome).toMatchObject({ skipped: false, summary: { status: "ok", newCount: 0 } });
  });

  it("en snart utgående koppling synkas som vanligt", async () => {
    const t = setup({ connection: { status: "expiring", consentExpiresOn: "2026-11-25" } });
    expect(await syncConnection(t.input)).toMatchObject({ skipped: false, summary: { status: "ok" } });
  });
});

describe("fel per konto (KK-7-B)", () => {
  it("ett konto som får rate limit stoppar inte det andra, och körningen blir partial", async () => {
    const t = setup({ bank: { "uid-1": { transactions: new ProviderError("RATE_LIMITED") }, "uid-2": { transactions: [bankTx({ providerTxId: "b" })] } } });
    const outcome = await syncConnection(t.input);
    expect(outcome).toMatchObject({ skipped: false, summary: { status: "partial", newCount: 1, errorCode: "EB_429" }, consentExpired: false, notifyFailure: false });
    expect(t.rows.map((r) => r.accountId)).toEqual(["acc_2"]);
    expect(t.events).toContain("outcome:partial");
    expect(t.events).not.toContain("expire");
  });

  it("ett fel på saldot avbryter bara det kontot, och inget sparas för det (varken saldo eller transaktioner)", async () => {
    const t = setup({ bank: { "uid-1": { transactions: [bankTx({ providerTxId: "a" })], balance: new ProviderError("UNAVAILABLE") }, "uid-2": { transactions: [bankTx({ providerTxId: "b" })] } } });
    const outcome = await syncConnection(t.input);
    expect(outcome).toMatchObject({ skipped: false, summary: { status: "partial", newCount: 1, errorCode: "EB_UNAVAILABLE" } });
    expect(t.rows.map((r) => r.accountId)).toEqual(["acc_2"]);
    expect([...t.balances.keys()]).toEqual(["acc_2"]);
  });

  it("om transaktionerna misslyckas sparas inte saldot heller", async () => {
    const t = setup({ bank: { "uid-1": { transactions: new ProviderError("RATE_LIMITED"), balance: 777 }, "uid-2": { transactions: [], balance: 5 } } });
    await syncConnection(t.input);
    expect([...t.balances.keys()]).toEqual(["acc_2"]);
  });

  it("401 från banken sätter kopplingen till utgången, utan felnotis", async () => {
    const t = setup({ bank: { "uid-1": { transactions: new ProviderError("UNAUTHORIZED") }, "uid-2": { transactions: new ProviderError("UNAUTHORIZED") } } });
    const outcome = await syncConnection(t.input);
    expect(outcome).toMatchObject({ skipped: false, summary: { status: "failed", errorCode: "CONSENT_EXPIRED" }, consentExpired: true, notifyFailure: false });
    expect(t.events).toEqual(["run:start", "run:finish", "outcome:failed", "expire"]);
  });

  it("ett utgånget samtycke enligt datum frågar inte banken alls och loggar en misslyckad körning", async () => {
    const t = setup({ connection: { consentExpiresOn: "2026-11-19" } });
    const outcome = await syncConnection(t.input);
    expect(outcome).toMatchObject({ skipped: false, summary: { status: "failed", errorCode: "CONSENT_EXPIRED" }, consentExpired: true, notifyFailure: false });
    expect(t.bank.calls).toEqual([]);
    expect(t.events).toEqual(["run:start", "run:finish", "outcome:failed", "expire"]);
  });

  it("notisen om misslyckad synk skickas vid tredje misslyckandet i rad och inte före", async () => {
    const failing = { "uid-1": { transactions: new ProviderError("UNAVAILABLE") }, "uid-2": { transactions: new ProviderError("UNAVAILABLE") } };
    const second = await syncConnection(setup({ failuresBefore: 1, bank: failing }).input);
    const third = await syncConnection(setup({ failuresBefore: 2, bank: failing }).input);
    const fourth = await syncConnection(setup({ failuresBefore: 3, bank: failing }).input);
    expect([second, third, fourth].map((o) => !o.skipped && o.notifyFailure)).toEqual([false, true, false]);
  });
});

describe("kopplingar som inte ska synkas", () => {
  it.each(["pending_auth", "revoked", "deleted", "expired"] as const)("status %s hoppas över utan körning och utan bankanrop", async (status) => {
    const t = setup({ connection: { status } });
    expect(await syncConnection(t.input)).toEqual({ skipped: true, reason: status });
    expect(t.events).toEqual([]);
    expect(t.bank.calls).toEqual([]);
  });
});
