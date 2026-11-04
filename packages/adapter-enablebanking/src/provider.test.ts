import { ProviderError } from "@kronkoll/domain";
import { describe, expect, it } from "vitest";
import { createEnableBankingProvider } from "./provider.ts";

/** Svar formade som Enable Bankings API, med påhittade värden (KK-13). */
type Routes = Record<string, unknown>;

function fakeApi(routes: Routes, status = 200) {
  const calls: { method: string; url: URL; auth: string | null }[] = [];
  const fetchImpl = (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push({ method: init?.method ?? "GET", url, auth: new Headers(init?.headers).get("authorization") });
    const key = url.pathname + (url.searchParams.get("continuation_key") ? `?${url.searchParams.get("continuation_key") ?? ""}` : "");
    const body = routes[key];
    if (body === undefined) return Promise.resolve(new Response("not found", { status: 404 }));
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  };
  const provider = createEnableBankingProvider({ signer: { sign: () => Promise.resolve("jwt-test") }, fetch: fetchImpl });
  return { provider, calls };
}

const tx = (overrides: Record<string, unknown>) => ({
  entry_reference: "ref-1",
  transaction_amount: { currency: "SEK", amount: "125.50" },
  credit_debit_indicator: "DBIT",
  status: "BOOK",
  booking_date: "2026-11-03",
  transaction_date: "2026-11-02",
  creditor: { name: "Fiktiva Livs AB" },
  debtor: { name: "Testperson" },
  remittance_information: ["Kortköp", "  1234 "],
  ...overrides,
});

describe("konton (KK-5-C)", () => {
  it("hämtar kontona i sessionen med typ, namn och IBAN", async () => {
    const { provider } = fakeApi({
      "/sessions/s1": { accounts: ["acc-1", "card-1"], status: "AUTHORIZED" },
      "/accounts/acc-1/details": { account_id: { iban: "SE4550000000058398257466" }, name: "Privatkonto", cash_account_type: "CACC", currency: "SEK" },
      "/accounts/card-1/details": { product: "Visa", cash_account_type: "CARD" },
    });
    expect(await provider.accounts("s1")).toEqual([
      { providerUid: "acc-1", iban: "SE4550000000058398257466", name: "Privatkonto", type: "checking", currency: "SEK" },
      { providerUid: "card-1", iban: null, name: "Visa", type: "credit_card", currency: "SEK" },
    ]);
  });

  it("avvisar en session utan kontolista", async () => {
    const { provider } = fakeApi({ "/sessions/s1": { accounts: "fel" } });
    await expect(provider.accounts("s1")).rejects.toEqual(new ProviderError("BAD_RESPONSE"));
  });
});

describe("saldo", () => {
  it("väljer bokfört saldo före tillgängligt, och tolkar negativa belopp", async () => {
    const { provider } = fakeApi({
      "/accounts/a/balances": {
        balances: [
          { balance_type: "ITAV", balance_amount: { currency: "SEK", amount: "500.00" } },
          { balance_type: "CLBD", balance_amount: { currency: "SEK", amount: "-3200.10" } },
        ],
      },
    });
    expect(await provider.balance("a")).toBe(-320010);
  });

  it("ger null om banken inte har något känt saldo", async () => {
    const { provider } = fakeApi({ "/accounts/a/balances": { balances: [{ balance_type: "OKÄND" }] } });
    expect(await provider.balance("a")).toBeNull();
  });
});

describe("transaktioner (KK-5-C, KK-11-C)", () => {
  it("mappar till domänens form och kastar resten av bankens svar", async () => {
    const { provider } = fakeApi({ "/accounts/a/transactions": { transactions: [tx({ extra_raw_field: "kastas" })], continuation_key: null } });
    expect(await provider.transactions("a", { dateFrom: "2026-08-01", continuationKey: null })).toEqual({
      transactions: [
        {
          providerTxId: "ref-1",
          status: "booked",
          transactionDate: "2026-11-02",
          bookingDate: "2026-11-03",
          amountMinor: -12550,
          counterparty: "Fiktiva Livs AB",
          description: "Kortköp 1234",
        },
      ],
      continuationKey: null,
    });
  });

  it("en insättning har positivt belopp och avsändaren som motpart; preliminära har inget bokföringsdatum", async () => {
    const { provider } = fakeApi({
      "/accounts/a/transactions": {
        transactions: [tx({ credit_debit_indicator: "CRDT", status: "PDNG", booking_date: null, entry_reference: null, transaction_id: "tid-9", debtor: { name: "Prov Arbetsgivare AB" } })],
      },
    });
    const [t] = (await provider.transactions("a", { dateFrom: "2026-08-01", continuationKey: null })).transactions;
    expect(t).toMatchObject({ status: "pending", bookingDate: null, amountMinor: 12550, counterparty: "Prov Arbetsgivare AB", providerTxId: "tid-9" });
  });

  it("hoppar över informationsrader, saknar motpart utan att fela och kortar beskrivningen till 140 tecken", async () => {
    const { provider } = fakeApi({
      "/accounts/a/transactions": {
        transactions: [tx({ status: "INFO" }), tx({ creditor: null, remittance_information: ["x".repeat(200)], transaction_date: null })],
      },
    });
    const page = await provider.transactions("a", { dateFrom: "2026-08-01", continuationKey: null });
    expect(page.transactions).toHaveLength(1);
    expect(page.transactions[0]).toMatchObject({ counterparty: "", transactionDate: "2026-11-03" });
    expect(page.transactions[0]?.description).toHaveLength(140);
  });

  it("hoppar över id med bara nollor och litar inte på id som återkommer på sidan, så att olika köp inte slås ihop", async () => {
    const { provider } = fakeApi({
      "/accounts/a/transactions": {
        transactions: [
          tx({ entry_reference: "0000000000", transaction_id: "tid-1" }),
          tx({ entry_reference: "dup" }),
          tx({ entry_reference: "dup", transaction_amount: { currency: "SEK", amount: "40.00" } }),
          tx({ entry_reference: "unik" }),
          tx({ entry_reference: "000", transaction_id: "0" }),
        ],
      },
    });
    const page = await provider.transactions("a", { dateFrom: "2026-08-01", continuationKey: null });
    expect(page.transactions.map((t) => t.providerTxId)).toEqual(["tid-1", null, null, "unik", null]);
    expect(page.transactions.map((t) => t.amountMinor)).toEqual([-12550, -12550, -4000, -12550, -12550]);
  });

  it("hämtar sida för sida med continuation key", async () => {
    const { provider, calls } = fakeApi({
      "/accounts/a/transactions": { transactions: [tx({})], continuation_key: "nästa" },
      "/accounts/a/transactions?nästa": { transactions: [tx({ entry_reference: "ref-2" })] },
    });
    const first = await provider.transactions("a", { dateFrom: "2026-08-01", continuationKey: null });
    expect(first.continuationKey).toBe("nästa");
    const second = await provider.transactions("a", { dateFrom: "2026-08-01", continuationKey: "nästa" });
    expect(second).toMatchObject({ continuationKey: null, transactions: [{ providerTxId: "ref-2" }] });
    expect(calls.map((c) => c.url.searchParams.get("date_from"))).toEqual(["2026-08-01", "2026-08-01"]);
    expect(calls.map((c) => c.url.searchParams.get("strategy"))).toEqual([null, null]);
  });

  it("utan startdatum ber den om så lång historik som banken tillåter, även på följande sidor (KK-5-C)", async () => {
    const { provider, calls } = fakeApi({
      "/accounts/a/transactions": { transactions: [tx({})], continuation_key: "nästa" },
      "/accounts/a/transactions?nästa": { transactions: [] },
    });
    await provider.transactions("a", { dateFrom: null, continuationKey: null });
    await provider.transactions("a", { dateFrom: null, continuationKey: "nästa" });
    expect(calls.map((c) => [c.url.searchParams.get("strategy"), c.url.searchParams.has("date_from")])).toEqual([
      ["longest", false],
      ["longest", false],
    ]);
  });

  it.each([
    ["fel valuta", tx({ transaction_amount: { currency: "EUR", amount: "1.00" } })],
    ["belopp som inte är ett tal", tx({ transaction_amount: { currency: "SEK", amount: "1e5" } })],
    ["okänd riktning", tx({ credit_debit_indicator: "?" })],
    ["inget datum", tx({ transaction_date: null, booking_date: "3 nov", value_date: undefined })],
    ["ingen rad", "inte ett objekt"],
  ])("avvisar en rad med %s", async (_, row) => {
    const { provider } = fakeApi({ "/accounts/a/transactions": { transactions: [row] } });
    await expect(provider.transactions("a", { dateFrom: "2026-08-01", continuationKey: null })).rejects.toEqual(new ProviderError("BAD_RESPONSE"));
  });
});

describe("bara läsande anrop (KK-5-A)", () => {
  it("använder GET med kortlivad JWT och kodar id:n i sökvägen", async () => {
    const { provider, calls } = fakeApi({ "/accounts/a%2F..%2Fsessions/balances": { balances: [] } });
    await provider.balance("a/../sessions");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "GET", auth: "Bearer jwt-test" });
    expect(calls[0]?.url.pathname).toBe("/accounts/a%2F..%2Fsessions/balances");
  });
});

describe("fel utan svarstext (KK-13)", () => {
  it.each([
    [401, "UNAUTHORIZED"],
    [403, "UNAUTHORIZED"],
    [429, "RATE_LIMITED"],
    [503, "UNAVAILABLE"],
    [422, "FAILED"],
  ])("HTTP %i ger %s", async (status, code) => {
    const { provider } = fakeApi({ "/accounts/a/balances": { message: "konto 1234 spärrat" } }, status);
    const error = await provider.balance("a").catch((e: unknown) => e);
    expect(error).toEqual(new ProviderError(code as never));
    expect(String(error)).not.toContain("1234");
  });

  it("nätverksfel ger UNAVAILABLE och ett svar som inte är JSON ger BAD_RESPONSE", async () => {
    const down = createEnableBankingProvider({ signer: { sign: () => Promise.resolve("x") }, fetch: () => Promise.reject(new Error("dns")) });
    await expect(down.balance("a")).rejects.toEqual(new ProviderError("UNAVAILABLE"));
    const html = createEnableBankingProvider({ signer: { sign: () => Promise.resolve("x") }, fetch: () => Promise.resolve(new Response("<html>")) });
    await expect(html.balance("a")).rejects.toEqual(new ProviderError("BAD_RESPONSE"));
    const list = createEnableBankingProvider({ signer: { sign: () => Promise.resolve("x") }, fetch: () => Promise.resolve(new Response("[]")) });
    await expect(list.balance("a")).rejects.toEqual(new ProviderError("BAD_RESPONSE"));
  });
});
