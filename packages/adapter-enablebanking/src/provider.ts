/**
 * Enable Banking som BankDataProvider (KK-5-A, KK-5-C, KK-14-B).
 *
 * - Bara läsande AIS-anrop med GET: session, kontodetaljer, saldon och transaktioner. Andra
 *   metoder eller sökvägar går inte att anropa härifrån.
 * - Svaren är opålitlig indata. De kontrolleras fält för fält och mappas till domänens typer,
 *   och allt annat kastas (KK-11-C). Ett fel innehåller bara en felkod, aldrig svarstexten.
 * - Transaktioner hämtas en sida i taget med continuation key, så att en synk kan delas upp.
 */
import {
  ProviderError,
  parseAmount,
  type BankAccount,
  type BankAccountType,
  type BankDataProvider,
  type ProviderTransaction,
} from "@kronkoll/domain";
import type { JwtSigner } from "./jwt.ts";

export interface EnableBankingOptions {
  readonly signer: JwtSigner;
  readonly fetch: typeof fetch;
  readonly baseUrl?: string;
}

const DESCRIPTION_MAX = 140;
const ACCOUNT_TYPES: Record<string, BankAccountType> = { CACC: "checking", CARD: "credit_card", SVGS: "savings", LOAN: "loan" };
/** Bokfört saldo först, sedan tillgängligt. */
const BALANCE_PREFERENCE = ["CLBD", "ITBD", "XPCD", "CLAV", "ITAV", "OPBD"];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);
const bad = (): never => {
  throw new ProviderError("BAD_RESPONSE");
};

function errorFor(status: number): ProviderError {
  if (status === 401 || status === 403) return new ProviderError("UNAUTHORIZED");
  if (status === 429) return new ProviderError("RATE_LIMITED");
  if (status >= 500) return new ProviderError("UNAVAILABLE");
  return new ProviderError("FAILED");
}

function amountOf(value: unknown): number {
  if (!isObject(value) || value.currency !== "SEK") return bad();
  try {
    return parseAmount(String(value.amount));
  } catch {
    return bad();
  }
}

function mapTransaction(raw: unknown): ProviderTransaction | null {
  if (!isObject(raw)) return bad();
  const status = raw.status === "BOOK" ? "booked" : raw.status === "PDNG" ? "pending" : null;
  if (status === null) return null; // t.ex. INFO: ingen riktig transaktion
  const magnitude = Math.abs(amountOf(raw.transaction_amount));
  const debit = raw.credit_debit_indicator === "DBIT";
  if (!debit && raw.credit_debit_indicator !== "CRDT") return bad();
  const date = (key: string) => {
    const value = text(raw[key]);
    return value !== null && ISO_DATE.test(value) ? value : null;
  };
  const transactionDate = date("transaction_date") ?? date("booking_date") ?? date("value_date") ?? bad();
  const party = debit ? raw.creditor : raw.debtor;
  const remittance = Array.isArray(raw.remittance_information) ? raw.remittance_information.filter((r) => typeof r === "string") : [];
  return {
    providerTxId: text(raw.entry_reference) ?? text(raw.transaction_id),
    status,
    transactionDate,
    bookingDate: date("booking_date"),
    amountMinor: debit ? -magnitude : magnitude,
    counterparty: (isObject(party) ? text(party.name) : null) ?? "",
    description: remittance.join(" ").replace(/\s+/gu, " ").trim().slice(0, DESCRIPTION_MAX),
  };
}

export function createEnableBankingProvider(options: EnableBankingOptions): BankDataProvider {
  const base = options.baseUrl ?? "https://api.enablebanking.com";

  async function get(path: string, query: Record<string, string> = {}): Promise<Json> {
    const url = new URL(path, base);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    let res: Response;
    try {
      res = await options.fetch(url, { method: "GET", headers: { authorization: `Bearer ${await options.signer.sign()}` } });
    } catch {
      throw new ProviderError("UNAVAILABLE");
    }
    if (!res.ok) throw errorFor(res.status);
    const body: unknown = await res.json().catch(bad);
    return isObject(body) ? body : bad();
  }

  const segment = (id: string) => encodeURIComponent(id);

  return {
    async accounts(sessionId) {
      const session = await get(`/sessions/${segment(sessionId)}`);
      const uids = Array.isArray(session.accounts) ? session.accounts.map((a) => text(a) ?? bad()) : bad();
      const accounts: BankAccount[] = [];
      for (const uid of uids) {
        const details = await get(`/accounts/${segment(uid)}/details`);
        const accountId = isObject(details.account_id) ? details.account_id : {};
        accounts.push({
          providerUid: uid,
          iban: text(accountId.iban),
          name: text(details.name) ?? text(details.product) ?? "Konto",
          type: ACCOUNT_TYPES[String(details.cash_account_type)] ?? "checking",
          currency: text(details.currency) ?? "SEK",
        });
      }
      return accounts;
    },

    async balance(accountUid) {
      const body = await get(`/accounts/${segment(accountUid)}/balances`);
      const balances = Array.isArray(body.balances) ? body.balances.filter(isObject) : bad();
      for (const type of BALANCE_PREFERENCE) {
        const match = balances.find((b) => b.balance_type === type);
        if (match) return amountOf(match.balance_amount);
      }
      return null;
    },

    async transactions(accountUid, query) {
      const params: Record<string, string> = { date_from: query.dateFrom };
      if (query.continuationKey !== null) params.continuation_key = query.continuationKey;
      const body = await get(`/accounts/${segment(accountUid)}/transactions`, params);
      const rows = Array.isArray(body.transactions) ? body.transactions : bad();
      return {
        transactions: rows.map(mapTransaction).filter((t): t is ProviderTransaction => t !== null),
        continuationKey: text(body.continuation_key),
      };
    },
  };
}
