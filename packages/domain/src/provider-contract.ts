/**
 * Kontraktssviten för porten BankDataProvider (KK-14-B, V-c-provider). Varje adapter ska klara
 * samma regler: Enable Banking mot sandboxen varje natt, och en CSV-adapter om den byggs (#29).
 *
 * Sviten hämtar som första synken (så lång historik som möjligt, sida för sida) och kontrollerar
 * att svaren följer domänens regler. Sammanfattningen innehåller bara typer, antal och datum,
 * aldrig belopp, motparter eller id:n (KK-13). Bankens fel släpps igenom till den som anropar.
 */
import type { BankAccountType, BankDataProvider, ProviderTransaction } from "./bank.ts";

export interface ContractAccountReport {
  readonly type: BankAccountType;
  readonly hasBalance: boolean;
  readonly pages: number;
  readonly booked: number;
  readonly pending: number;
  /** Äldsta transaktionsdatum, eller null om kontot saknar transaktioner. */
  readonly oldest: string | null;
}

export interface ContractReport {
  readonly accounts: readonly ContractAccountReport[];
  /** Reglerna som inte höll, var och en en gång. Tom när leverantören klarar sviten. */
  readonly failures: readonly string[];
}

export interface ContractOptions {
  /** Fler sidor än så räknas som en historik som aldrig tar slut. */
  readonly maxPages?: number;
  /** Anropas när ett nytt steg börjar, så att ett fel går att knyta till steget. */
  readonly onStep?: (step: string) => void;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const DESCRIPTION_MAX = 140;

export async function runProviderContract(provider: BankDataProvider, sessionId: string, options: ContractOptions = {}): Promise<ContractReport> {
  const maxPages = options.maxPages ?? 50;
  const step = options.onStep ?? (() => undefined);
  const failures = new Set<string>();
  const expect = (ok: boolean, rule: string) => {
    if (!ok) failures.add(rule);
  };

  step("sessionen och kontona");
  const accounts = await provider.accounts(sessionId);
  expect(accounts.length > 0, "sessionen har minst ett konto");

  const reports: ContractAccountReport[] = [];
  for (const [index, account] of accounts.entries()) {
    const n = String(index + 1);
    expect(account.providerUid !== "", "kontot har ett uid");
    step(`saldo för konto ${n}`);
    const balance = await provider.balance(account.providerUid);
    expect(balance === null || Number.isSafeInteger(balance), "saldot är heltal öre");

    step(`transaktioner för konto ${n}`);
    const all: ProviderTransaction[] = [];
    let key: string | null = null;
    let pages = 0;
    do {
      const page = await provider.transactions(account.providerUid, { dateFrom: null, continuationKey: key });
      all.push(...page.transactions);
      expect(page.continuationKey !== key || key === null, "continuation key byts mellan sidor");
      key = page.continuationKey;
      pages += 1;
    } while (key !== null && pages < maxPages);
    expect(key === null, `historiken tar slut inom ${String(maxPages)} sidor`);

    for (const t of all) {
      expect(Number.isSafeInteger(t.amountMinor) && t.amountMinor !== 0, "beloppet är heltal öre och inte noll");
      expect(ISO_DATE.test(t.transactionDate), "transaktionsdatum är YYYY-MM-DD");
      expect(t.status === "pending" || t.bookingDate !== null, "en bokförd transaktion har bokföringsdatum");
      expect(t.description.length <= DESCRIPTION_MAX, "beskrivningen är högst 140 tecken");
    }
    const ids = all.map((t) => t.providerTxId).filter((id) => id !== null);
    expect(new Set(ids).size === ids.length, "bankens id är unika inom kontot");

    const booked = all.filter((t) => t.status === "booked").length;
    reports.push({
      type: account.type,
      hasBalance: balance !== null,
      pages,
      booked,
      pending: all.length - booked,
      oldest: all.map((t) => t.transactionDate).sort()[0] ?? null,
    });
  }
  return { accounts: reports, failures: [...failures] };
}
