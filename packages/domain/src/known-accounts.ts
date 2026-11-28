/**
 * Kända konton (KK-54): konton som inte är kopplade till appen, t.ex. en partners. Skandia skickar ingen
 * motpart, så en överföring känns bara igen på texten i meddelandet. Ett känt konto har ett namn, en eller
 * flera matchningstexter (Innehåller, som KK-47) och en standardkategori.
 *
 * Matchningen återanvänder reglernas: varje text blir en Innehåller-regel (`knownAccountRules`), så att
 * kategorin följer samma prioritet som regler (KK-58) och förhandsvisningen räknar som regelns.
 * Texterna är banktext från användaren och renderas alltid som text (KK-30).
 */
import { matchingRule, type CategoryRule } from "./categorize.ts";

export interface KnownAccount {
  readonly id: string;
  readonly name: string;
  /** Normaliserade texter (versaler, ett mellanslag mellan orden). Träffar om transaktionen innehåller någon. */
  readonly patterns: readonly string[];
  readonly categoryId: string;
}

export interface KnownAccountTransaction {
  readonly id: string;
  readonly counterpartyNorm: string;
  readonly description: string;
}

/** Som en Innehåller-regel (KK-47-A): versaler och ett mellanslag mellan orden. */
export function normalizeKnownPattern(text: string): string {
  const pattern = text.trim().replace(/\s+/gu, " ").toLocaleUpperCase("sv-SE");
  if (pattern === "") throw new RangeError("Matchningstexten får inte vara tom");
  return pattern;
}

/** Kontrollerar och normaliserar ett konto innan det sparas. */
export function validateKnownAccount(account: KnownAccount): KnownAccount {
  const name = account.name.trim();
  if (name === "") throw new RangeError("Kontot måste ha ett namn");
  const patterns = [...new Set(account.patterns.map(normalizeKnownPattern))];
  if (patterns.length === 0) throw new RangeError("Minst en matchningstext krävs");
  return { ...account, name, patterns };
}

const ruleId = (accountId: string, index: number) => `known:${accountId}:${String(index)}`;
const accountOf = (id: string) => id.split(":")[1] ?? "";

/** En regel per matchningstext. Av samma slag som egna regler, utan plats i användarens ordning. */
export function knownAccountRules(accounts: readonly KnownAccount[]): CategoryRule[] {
  return accounts.flatMap((a) =>
    a.patterns.map((pattern, i): CategoryRule => ({
      id: ruleId(a.id, i),
      match: "description_contains",
      pattern,
      categoryId: a.categoryId,
      source: "learned",
    })),
  );
}

/**
 * Kontot en transaktion hör till. En manuell koppling (KK-54-C) går före matchning och skrivs aldrig över av
 * regler, men en koppling till ett konto som tagits bort räknas inte. Annars vinner längsta texten.
 */
export function knownAccountFor(
  tx: KnownAccountTransaction,
  accounts: readonly KnownAccount[],
  manualAccountId?: string | null,
): KnownAccount | null {
  const manual = accounts.find((a) => a.id === manualAccountId);
  if (manual) return manual;
  const hit = matchingRule(tx, knownAccountRules(accounts));
  return accounts.find((a) => a.id === accountOf(hit ?? "")) ?? null;
}

/** Hur många transaktioner kontot träffar, där det vinner. För förhandsvisningen innan det sparas (KK-54-A). */
export function knownAccountHits(
  transactions: readonly KnownAccountTransaction[],
  accounts: readonly KnownAccount[],
  accountId: string,
): number {
  return transactions.filter((tx) => knownAccountFor(tx, accounts)?.id === accountId).length;
}
