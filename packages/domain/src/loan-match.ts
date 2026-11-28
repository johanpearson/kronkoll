/**
 * Lån med kontouppgifter (KK-59): betalningar till ett lån känns igen på användarens matchningstexter,
 * t.ex. lånets kontonummer, OCR eller långivarens namn, och kopplas till lånet.
 *
 * Texterna jämförs i bankens råa motpart och meddelande, inte i den normaliserade motparten, eftersom
 * normaliseringen tar bort siffror. Mellanslag, bindestreck, punkter och snedstreck tas bort på båda
 * sidor, så att "9020-12 345 67" träffar "9020 1234567". Bara utbetalningar kan vara lånebetalningar.
 * Matchningstexterna är användarens egna och visas alltid som text (KK-30).
 */
import type { TransactionStatus } from "./reconcile.ts";
import { sumMinor } from "./money.ts";
import type { BudgetPeriod } from "./period.ts";

/** Kortare mönster än så (utan skiljetecken) träffar för mycket och används inte. */
export const LOAN_PATTERN_MIN_LENGTH = 3;
/** Antal exempel i förhandsvisningen (KK-59-A). */
export const LOAN_PREVIEW_EXAMPLES = 3;

export interface LoanMatcher {
  readonly loanId: string;
  /** Användarens matchningstexter som de skrevs. */
  readonly patterns: readonly string[];
}

/** Hur kopplingen kom till: av matchningen, eller av användaren (satt eller borttagen för hand). */
export type LoanLinkSource = "auto" | "manual";

export interface LoanTransaction {
  readonly id: string;
  /** Bokföringsdagen, annars köpdagen, som i budgeten. */
  readonly date: string;
  readonly status: TransactionStatus;
  readonly amountMinor: number;
  /** Bankens text som den kom. */
  readonly counterparty: string;
  readonly description: string;
  readonly loanId: string | null;
  /** Null när ingen koppling har satts. "manual" med loanId null betyder att användaren har tagit bort kopplingen. */
  readonly loanSource: LoanLinkSource | null;
}

export interface LoanLinkChange {
  readonly id: string;
  readonly loanId: string | null;
}

const SEPARATORS = /[\s\-./]/gu;
const compact = (text: string): string => text.toLocaleUpperCase("sv-SE").replace(SEPARATORS, "");

/** Matchningstexten som den jämförs, eller null om den är för kort för att användas. */
export function normalizeLoanPattern(pattern: string): string | null {
  const value = compact(pattern);
  return value.length >= LOAN_PATTERN_MIN_LENGTH ? value : null;
}

interface CompiledMatcher {
  readonly loanId: string;
  readonly patterns: readonly string[];
}

const usable = (patterns: readonly string[]): string[] =>
  patterns.map(normalizeLoanPattern).filter((p): p is string => p !== null);

const compile = (loans: readonly LoanMatcher[]): CompiledMatcher[] => loans.map((l) => ({ loanId: l.loanId, patterns: usable(l.patterns) }));

/** Lånet med det längsta mönster som finns i texten, sedan lägsta lån-id. */
function bestMatch(text: string, loans: readonly CompiledMatcher[]): string | null {
  let best: { loanId: string; length: number } | null = null;
  for (const loan of loans) {
    for (const pattern of loan.patterns) {
      if (!text.includes(pattern)) continue;
      if (best === null || pattern.length > best.length || (pattern.length === best.length && loan.loanId < best.loanId)) {
        best = { loanId: loan.loanId, length: pattern.length };
      }
    }
  }
  return best?.loanId ?? null;
}

const searchText = (tx: Pick<LoanTransaction, "counterparty" | "description">) => compact(`${tx.counterparty} ${tx.description}`);
const canMatch = (tx: Pick<LoanTransaction, "amountMinor" | "status">) => tx.amountMinor < 0 && tx.status !== "removed";

function matchCompiled(tx: LoanTransaction, loans: readonly CompiledMatcher[]): string | null {
  return canMatch(tx) ? bestMatch(searchText(tx), loans) : null;
}

/** Lånet som en transaktion hör till enligt matchningstexterna, eller null (KK-59-B). */
export function matchLoan(tx: LoanTransaction, loans: readonly LoanMatcher[]): string | null {
  return matchCompiled(tx, compile(loans));
}

/**
 * Räknar om kopplingarna, t.ex. efter en synk eller när ett låns matchningstexter ändras. Kopplingar som
 * användaren har satt eller tagit bort för hand rörs aldrig. Returnerar bara de som ändras.
 */
export function linkLoans(transactions: readonly LoanTransaction[], loans: readonly LoanMatcher[]): LoanLinkChange[] {
  const compiled = compile(loans);
  return transactions.flatMap((tx) => {
    if (tx.loanSource === "manual") return [];
    const loanId = matchCompiled(tx, compiled);
    return loanId === tx.loanId ? [] : [{ id: tx.id, loanId }];
  });
}

export interface LoanMatchPreview {
  readonly count: number;
  /** De senaste träffarna, nyast först. */
  readonly examples: readonly LoanTransaction[];
}

/** Hur många transaktioner matchningstexterna träffar, med några exempel, innan lånet sparas (KK-59-A). */
export function loanMatchPreview(transactions: readonly LoanTransaction[], patterns: readonly string[]): LoanMatchPreview {
  const wanted = usable(patterns);
  const hits = transactions.filter((tx) => canMatch(tx) && wanted.some((p) => searchText(tx).includes(p)));
  const examples = [...hits].sort((a, b) => b.date.localeCompare(a.date)).slice(0, LOAN_PREVIEW_EXAMPLES);
  return { count: hits.length, examples };
}

export interface LoanPaid {
  /** Summan av lånets betalningar i perioden, som positivt belopp. */
  readonly paidMinor: number;
  readonly lastPaidOn: string | null;
  /** Perioden är slut (sista dagen eller senare) och ingen betalning har kommit. */
  readonly missing: boolean;
}

/** Betalt denna period för ett lån (KK-59-C). */
export function loanPaidInPeriod(input: {
  readonly loanId: string;
  readonly transactions: readonly LoanTransaction[];
  readonly period: BudgetPeriod;
  readonly today: string;
}): LoanPaid {
  const { period } = input;
  const payments = input.transactions.filter(
    (tx) => tx.loanId === input.loanId && tx.status !== "removed" && tx.date >= period.start && tx.date <= period.end,
  );
  const paidMinor = sumMinor(payments.map((tx) => -tx.amountMinor));
  const lastPaidOn = payments.map((tx) => tx.date).sort().at(-1) ?? null;
  return { paidMinor, lastPaidOn, missing: payments.length === 0 && input.today >= period.end };
}
