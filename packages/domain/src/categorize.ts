/**
 * Kategorisering med deterministiska regler (KK-18, beslut D-rules).
 *
 * Prioritet: en manuellt satt kategori rörs aldrig (KK-18-C). Bland reglerna vinner en inlärd
 * över en mallregel, sedan exakt matchning före prefix före text i beskrivningen, sedan längre
 * mönster. "Gör alltid så" lär in en regel på hela den normaliserade motparten (KK-18-B).
 */
import { learnPattern, matchesWordPrefix, normalizeCounterparty } from "./normalize.ts";

export type CategorySource = "manual" | "learned" | "template" | "none";

export interface CategoryRule {
  readonly id: string;
  readonly match: "counterparty_exact" | "counterparty_prefix" | "description_contains";
  /** Normaliserad text (versaler). */
  readonly pattern: string;
  readonly categoryId: string;
  readonly source: "learned" | "template";
}

export interface CategorizableTransaction {
  readonly id: string;
  readonly counterpartyNorm: string;
  readonly description: string;
  readonly categoryId: string | null;
  readonly categorySource: CategorySource;
}

export interface Categorization {
  readonly categoryId: string | null;
  readonly source: CategorySource;
  readonly ruleId: string | null;
}

const MATCH_RANK: Record<CategoryRule["match"], number> = {
  counterparty_exact: 0,
  counterparty_prefix: 1,
  description_contains: 2,
};

/**
 * Det motpartsreglerna matchar och lär sig på: den normaliserade motparten, eller beskrivningen
 * normaliserad på samma sätt när banken inte skickar någon motpart. Skandia gör så för kortköp och
 * lägger butiken i beskrivningen. Avstämningen mot banken använder fortfarande bara motparten.
 */
export function ruleKey(tx: Pick<CategorizableTransaction, "counterpartyNorm" | "description">): string {
  return tx.counterpartyNorm !== "" ? tx.counterpartyNorm : normalizeCounterparty(tx.description);
}

/** Det en transaktion matchas på, uträknat en gång per transaktion i stället för en gång per regel. */
interface MatchText {
  readonly key: string;
  readonly description: string;
}

function matches(rule: CategoryRule, text: MatchText): boolean {
  switch (rule.match) {
    case "counterparty_exact":
      return rule.pattern !== "" && text.key === rule.pattern;
    case "counterparty_prefix":
      return matchesWordPrefix(rule.pattern, text.key);
    case "description_contains":
      return rule.pattern !== "" && text.description.includes(rule.pattern);
  }
}

function byPriority(a: CategoryRule, b: CategoryRule): number {
  return (
    (a.source === "learned" ? 0 : 1) - (b.source === "learned" ? 0 : 1) ||
    MATCH_RANK[a.match] - MATCH_RANK[b.match] ||
    b.pattern.length - a.pattern.length ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** Kategorin en transaktion ska ha, eller null om ingen regel matchar och den inte är manuell. */
export function categorize(tx: CategorizableTransaction, rules: readonly CategoryRule[]): Categorization | null {
  if (tx.categorySource === "manual") {
    return { categoryId: tx.categoryId, source: "manual", ruleId: null };
  }
  // Normaliseringen är det dyra steget, och Workern har lite processortid per anrop. Gör den en gång.
  const text = { key: ruleKey(tx), description: tx.description.toLocaleUpperCase("sv-SE") };
  const rule = rules.filter((r) => matches(r, text)).sort(byPriority)[0];
  return rule ? { categoryId: rule.categoryId, source: rule.source, ruleId: rule.id } : null;
}

export interface CategoryChange {
  readonly id: string;
  readonly categoryId: string | null;
  readonly categorySource: CategorySource;
}

/**
 * Räknar om kategorin för alla transaktioner som inte är manuella, t.ex. när en regel har
 * lärts in eller ändrats och ska appliceras bakåt. Returnerar bara de som ändras.
 */
export function applyRules(
  transactions: readonly CategorizableTransaction[],
  rules: readonly CategoryRule[],
): CategoryChange[] {
  const changes: CategoryChange[] = [];
  for (const tx of transactions) {
    if (tx.categorySource === "manual") continue;
    const result = categorize(tx, rules);
    const categoryId = result?.categoryId ?? null;
    const categorySource = result?.source ?? "none";
    if (categoryId !== tx.categoryId || categorySource !== tx.categorySource) {
      changes.push({ id: tx.id, categoryId, categorySource });
    }
  }
  return changes;
}

export interface LearnInput {
  readonly transaction: CategorizableTransaction;
  readonly categoryId: string;
  /** Användaren kryssade i "Gör alltid så". */
  readonly alwaysDoThis: boolean;
  /**
   * Hur mycket av namnet regeln gäller, ett av `patternChoices`. Utan val blir det hela namnet. Ett
   * kortare val, t.ex. "IKEA", träffar alla varuhus i kedjan.
   */
  readonly pattern?: string;
  readonly rules: readonly CategoryRule[];
  readonly newId: () => string;
}

export interface LearnResult {
  readonly transaction: CategorizableTransaction;
  /** Ny eller uppdaterad inlärd regel, eller null om ingen regel lärs in. */
  readonly rule: CategoryRule | null;
}

/**
 * Vad en inlärd regel kan gälla för en transaktion: hela namnet först, sedan allt kortare som börjar på
 * ett helt ord, t.ex. "IKEA KUNGENS KURVA", "IKEA KUNGENS", "IKEA". Användaren väljer; standard är
 * hela namnet, eftersom första ordet ofta är för brett ("SWISH").
 */
export function patternChoices(tx: Pick<CategorizableTransaction, "counterpartyNorm" | "description">): string[] {
  const words = (learnPattern(ruleKey(tx)) ?? "").split(" ").filter((w) => w !== "");
  return words.map((_, i) => words.slice(0, words.length - i).join(" "));
}

/** Användaren väljer en kategori för en transaktion, och kanske "Gör alltid så". */
export function learnFromManualChoice(input: LearnInput): LearnResult {
  const transaction = { ...input.transaction, categoryId: input.categoryId, categorySource: "manual" as const };
  if (!input.alwaysDoThis) return { transaction, rule: null };
  const choices = patternChoices(input.transaction);
  if (input.pattern !== undefined && !choices.includes(input.pattern)) {
    throw new RangeError("Regeln måste gälla början av namnet, hela ord");
  }
  const pattern = input.pattern ?? choices[0] ?? null;
  if (pattern === null) return { transaction, rule: null };

  const existing = input.rules.find(
    (r) => r.source === "learned" && r.match === "counterparty_prefix" && r.pattern === pattern,
  );
  const rule: CategoryRule = existing
    ? { ...existing, categoryId: input.categoryId }
    : { id: input.newId(), match: "counterparty_prefix", pattern, categoryId: input.categoryId, source: "learned" };
  return { transaction, rule };
}

export interface RuleReach {
  /** Transaktioner som får en ny kategori om regeln appliceras bakåt. */
  readonly changes: readonly CategoryChange[];
  /** Manuellt kategoriserade transaktioner som regeln matchar men aldrig ändrar (KK-18-C). */
  readonly protectedManual: number;
}

/**
 * Vad en regel skulle göra med historiken om den appliceras bakåt, till exempel efter "Gör alltid
 * så" (KK-18-B). Bara transaktioner där just den här regeln vinner räknas, så att en annan regel
 * med högre prioritet aldrig skrivs över. Manuella transaktioner ändras aldrig, men räknas.
 */
export function ruleReach(transactions: readonly CategorizableTransaction[], rules: readonly CategoryRule[], ruleId: string): RuleReach {
  const changes: CategoryChange[] = [];
  let protectedManual = 0;
  for (const tx of transactions) {
    if (tx.categorySource === "manual") {
      if (categorize({ ...tx, categorySource: "none" }, rules)?.ruleId === ruleId) protectedManual += 1;
      continue;
    }
    const result = categorize(tx, rules);
    if (result?.ruleId === ruleId && (result.categoryId !== tx.categoryId || result.source !== tx.categorySource)) {
      changes.push({ id: tx.id, categoryId: result.categoryId, categorySource: result.source });
    }
  }
  return { changes, protectedManual };
}

/**
 * Hur många transaktioner varje regel träffar, för regellistan: där regeln är den som vinner, med
 * manuellt valda inräknade (de visar vad regeln skulle ge, även om de aldrig ändras). Regler utan träffar
 * saknas i resultatet.
 */
export function ruleHits(transactions: readonly CategorizableTransaction[], rules: readonly CategoryRule[]): Map<string, number> {
  const hits = new Map<string, number>();
  for (const tx of transactions) {
    const ruleId = categorize({ ...tx, categorySource: "none" }, rules)?.ruleId;
    if (ruleId) hits.set(ruleId, (hits.get(ruleId) ?? 0) + 1);
  }
  return hits;
}
