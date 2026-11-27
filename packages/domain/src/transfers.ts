/**
 * Interna överföringar och kortfaktura (KK-20-C). Sådana transaktioner flyttar bara pengar mellan
 * hushållets egna konton och räknas därför inte som utgift eller inkomst i budgeten.
 *
 * 0. En dold transaktion (KK-49) räknas aldrig och ingår aldrig i ett par. Det vinner över allt, men rör inte
 *    användarens egen markering, som gäller igen när transaktionen visas.
 * 1. En manuell markering vinner alltid ("är en överföring" eller "inte en överföring").
 * 2. Par: motsatta belopp på två olika egna konton inom ±3 dagar. Varje transaktion ingår i högst
 *    ett par, och närmast i datum vinner. Eftersom Visa-kortet är ett eget konto fångar detta även
 *    betalningen av kortfakturan.
 *    Kontots roll (KK-53) avgör hur paret räknas. Inkomst/Utgift → Buffert är sparande på Inkomst/Utgift-kontot
 *    (KK-52-A), och Buffert → Inkomst/Utgift är ett uttag från sparande (KK-55): varken inkomst eller utgift.
 *    Buffertens egen rad räknas aldrig. Alla andra par är interna.
 * 2b. En insättning på en buffert från ett uteslutet konto (samma belopp, ±3 dagar) är en insättning på
 *    bufferten och inte en inkomst (KK-53, antagande).
 * 3. Kortfaktura utan motpost: ett uttag från ett eget konto som inte är ett kortkonto, till en
 *    känd kortmottagare (t.ex. "skandia visa"). Listan är konfigurerbar (antagande A-6).
 * 4. Regler med åtgärden Räkna inte (KK-39-C): det användaren vill hålla utanför budget och översikt,
 *    t.ex. utlägg som betalas tillbaka. De är inte överföringar, men räknas inte på samma sätt.
 *
 * 5. Uteslutna konton (KK-53, tidigare KK-41): deras transaktioner räknas inte och syns inte i listan, och de
 *    ingår aldrig i ett par. En överföring dit är därför en vanlig utgift på det andra kontot, och en
 *    överföring därifrån en vanlig inkomst.
 *
 * En insättning på kortkontot utan motpost räknas inte som intern: det kan vara en återbetalning.
 */
import { daysBetween, parseDate } from "./calendar.ts";
import { matchingRule, type RuleCondition } from "./categorize.ts";
import { assertMinor } from "./money.ts";

export const TRANSFER_WINDOW_DAYS = 3;

/** Kontots roll (KK-53): Inkomst/Utgift, Buffert eller Uteslutet. */
export type AccountRole = "spending" | "buffer" | "excluded";

export interface OwnAccount {
  readonly id: string;
  readonly type: "checking" | "savings" | "credit_card" | "manual";
  /** Kontots roll (KK-53). Vinner över de gamla brytarna nedan. */
  readonly role?: AccountRole;
  /** Ersätts av role (KK-53) och tas bort när databasen har rollen. Kontot räknas med (KK-41-A). Utelämnat betyder att det räknas med. */
  readonly counted?: boolean;
  /** Ersätts av role (KK-53) och tas bort när databasen har rollen. Ett sparkonto (KK-52). Utelämnat betyder att det inte är det. */
  readonly saving?: boolean;
}

/**
 * Kontots roll. Saknas den gäller samma regel som migreringen (KK-53-B): ett konto som inte räknas med är
 * Uteslutet, ett sparkonto är Buffert och resten är Inkomst/Utgift.
 */
export function accountRole(account: OwnAccount): AccountRole {
  if (account.role !== undefined) return account.role;
  if (account.counted === false) return "excluded";
  return account.saving === true ? "buffer" : "spending";
}

export interface TransferInput {
  readonly id: string;
  readonly accountId: string;
  readonly transactionDate: string;
  readonly amountMinor: number;
  readonly counterpartyNorm: string;
  readonly status: "pending" | "booked" | "removed";
  /** Användarens egen markering: true = överföring, false = inte överföring, null = automatiskt. */
  readonly manualTransfer: boolean | null;
  /** Bankens meddelande, för regler som Räkna inte när banken inte skickar motpart (KK-39-C). */
  readonly description: string;
  /** Dold av användaren (KK-49): räknas inte och ingår aldrig i ett par. Utelämnat betyder inte dold. */
  readonly hidden?: boolean;
}

/** En regel med åtgärden Räkna inte: bara villkoret, ingen kategori (KK-39-C). */
export type ExcludeRule = RuleCondition;

export interface TransferClassification {
  readonly id: string;
  readonly internal: boolean;
  /** Den andra halvan av en överföring, om den finns. */
  readonly pairId: string | null;
  readonly reason: "hidden" | "manual" | "pair" | "saving" | "saving_withdrawal" | "saving_deposit" | "card_payment" | "rule" | "account" | "none";
}

export interface ClassifyTransfersInput {
  readonly transactions: readonly TransferInput[];
  readonly accounts: readonly OwnAccount[];
  /** Normaliserade motparter som betyder "betalning av kortfaktura". */
  readonly cardPaymentCounterparties: readonly string[];
  /** Regler med åtgärden Räkna inte. De gäller hela historiken, men aldrig före ett eget val eller ett par. */
  readonly excludeRules: readonly ExcludeRule[];
}

const byDateThenId = (a: TransferInput, b: TransferInput): number =>
  a.transactionDate < b.transactionDate ? -1 : a.transactionDate > b.transactionDate ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

export function classifyTransfers(input: ClassifyTransfersInput): TransferClassification[] {
  for (const tx of input.transactions) {
    assertMinor(tx.amountMinor);
    parseDate(tx.transactionDate);
  }
  const accountType = new Map(input.accounts.map((a) => [a.id, a.type]));
  const role = new Map(input.accounts.map((a) => [a.id, accountRole(a)]));
  const uncounted = new Set(input.accounts.filter((a) => role.get(a.id) === "excluded").map((a) => a.id));
  const savingAccounts = new Set(input.accounts.filter((a) => role.get(a.id) === "buffer").map((a) => a.id));
  const cardPayees = new Set(input.cardPaymentCounterparties);
  const result = new Map<string, TransferClassification>();

  // 0. Dolda transaktioner (KK-49) och 1. manuella markeringar.
  for (const tx of input.transactions) {
    if (tx.hidden === true) {
      result.set(tx.id, { id: tx.id, internal: true, pairId: null, reason: "hidden" });
    } else if (tx.manualTransfer !== null) {
      result.set(tx.id, { id: tx.id, internal: tx.manualTransfer, pairId: null, reason: "manual" });
    }
  }

  // 2. Par mellan olika egna konton.
  const eligible = input.transactions
    .filter((tx) => tx.hidden !== true && tx.manualTransfer === null && tx.status !== "removed" && accountType.has(tx.accountId) && !uncounted.has(tx.accountId))
    .sort(byDateThenId);
  const paired = new Set<string>();
  for (const out of eligible.filter((tx) => tx.amountMinor < 0)) {
    const match = eligible
      .filter(
        (tx) =>
          !paired.has(tx.id) &&
          tx.amountMinor === -out.amountMinor &&
          tx.accountId !== out.accountId &&
          Math.abs(daysBetween(out.transactionDate, tx.transactionDate)) <= TRANSFER_WINDOW_DAYS,
      )
      .sort(
        (a, b) =>
          Math.abs(daysBetween(out.transactionDate, a.transactionDate)) -
            Math.abs(daysBetween(out.transactionDate, b.transactionDate)) || byDateThenId(a, b),
      )[0];
    if (match) {
      paired.add(out.id).add(match.id);
      const toSaving = !savingAccounts.has(out.accountId) && savingAccounts.has(match.accountId);
      const fromSaving = savingAccounts.has(out.accountId) && !savingAccounts.has(match.accountId);
      // Till en buffert är sparande, räknat på det andra kontot (KK-52-A). Från en buffert är ett uttag från
      // sparande (KK-55), som inte räknas som inkomst. Buffertens egen rad räknas aldrig.
      result.set(out.id, toSaving ? { id: out.id, internal: false, pairId: null, reason: "saving" } : { id: out.id, internal: true, pairId: match.id, reason: "pair" });
      result.set(match.id, { id: match.id, internal: true, pairId: out.id, reason: fromSaving ? "saving_withdrawal" : "pair" });
    }
  }

  // 2b. Uteslutet → Buffert: en insättning på bufferten, inte en inkomst (KK-53). Det uteslutna kontots rad
  // räknas inte ändå (steg 5), så bara buffertens rad markeras. Uttaget är negativt, så insättningen blir positiv.
  // Varje uttag används högst en gång, det tidigaste först.
  const excludedOut = input.transactions
    .filter((tx) => tx.hidden !== true && tx.manualTransfer === null && tx.status !== "removed" && tx.amountMinor < 0 && uncounted.has(tx.accountId))
    .sort(byDateThenId);
  const usedOut = new Set<string>();
  for (const deposit of eligible.filter((tx) => !paired.has(tx.id) && savingAccounts.has(tx.accountId))) {
    const source = excludedOut.find(
      (tx) => !usedOut.has(tx.id) && tx.amountMinor === -deposit.amountMinor && Math.abs(daysBetween(tx.transactionDate, deposit.transactionDate)) <= TRANSFER_WINDOW_DAYS,
    );
    if (source) {
      usedOut.add(source.id);
      result.set(deposit.id, { id: deposit.id, internal: true, pairId: null, reason: "saving_deposit" });
    }
  }

  // 3. Kortfaktura utan motpost.
  for (const tx of eligible) {
    const type = accountType.get(tx.accountId);
    if (!paired.has(tx.id) && tx.amountMinor < 0 && type !== "credit_card" && cardPayees.has(tx.counterpartyNorm)) {
      result.set(tx.id, { id: tx.id, internal: true, pairId: null, reason: "card_payment" });
    }
  }

  // 4. Regler med åtgärden Räkna inte (KK-39-C), för det som inte redan är avgjort.
  for (const tx of eligible) {
    if (!result.has(tx.id) && matchingRule(tx, input.excludeRules) !== null) {
      result.set(tx.id, { id: tx.id, internal: true, pairId: null, reason: "rule" });
    }
  }

  // 5. Uteslutna konton (KK-53, tidigare KK-41-A), för det som inte redan är avgjort av ett eget val.
  for (const tx of input.transactions) {
    if (tx.hidden !== true && tx.manualTransfer === null && tx.status !== "removed" && uncounted.has(tx.accountId)) {
      result.set(tx.id, { id: tx.id, internal: true, pairId: null, reason: "account" });
    }
  }

  return input.transactions.map(
    (tx) => result.get(tx.id) ?? { id: tx.id, internal: false, pairId: null, reason: "none" },
  );
}

/**
 * Hur många transaktioner varje Räkna inte-regel träffar, för regellistan. Egna val räknas med, som för
 * kategoriregler: de visar vad regeln gäller även när den inte bestämmer. Regler utan träffar saknas.
 */
export function excludeRuleHits(transactions: readonly TransferInput[], rules: readonly ExcludeRule[]): Map<string, number> {
  const hits = new Map<string, number>();
  for (const tx of transactions) {
    if (tx.status === "removed") continue;
    const ruleId = matchingRule(tx, rules);
    if (ruleId !== null) hits.set(ruleId, (hits.get(ruleId) ?? 0) + 1);
  }
  return hits;
}
