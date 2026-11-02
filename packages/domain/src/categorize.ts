/**
 * Kategorisering med deterministiska regler (KK-18, beslut D-rules).
 *
 * Prioritet: en manuellt satt kategori rörs aldrig (KK-18-C). Bland reglerna vinner en inlärd
 * över en mallregel, sedan exakt matchning före prefix före text i beskrivningen, sedan längre
 * mönster. "Gör alltid så" lär in en regel på hela den normaliserade motparten (KK-18-B).
 */
import { learnPattern, matchesWordPrefix } from "./normalize.ts";

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

function matches(rule: CategoryRule, tx: CategorizableTransaction): boolean {
  switch (rule.match) {
    case "counterparty_exact":
      return rule.pattern !== "" && tx.counterpartyNorm === rule.pattern;
    case "counterparty_prefix":
      return matchesWordPrefix(rule.pattern, tx.counterpartyNorm);
    case "description_contains":
      return rule.pattern !== "" && tx.description.toLocaleUpperCase("sv-SE").includes(rule.pattern);
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
  const rule = rules.filter((r) => matches(r, tx)).sort(byPriority)[0];
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
  readonly rules: readonly CategoryRule[];
  readonly newId: () => string;
}

export interface LearnResult {
  readonly transaction: CategorizableTransaction;
  /** Ny eller uppdaterad inlärd regel, eller null om ingen regel lärs in. */
  readonly rule: CategoryRule | null;
}

/** Användaren väljer en kategori för en transaktion, och kanske "Gör alltid så". */
export function learnFromManualChoice(input: LearnInput): LearnResult {
  const transaction = { ...input.transaction, categoryId: input.categoryId, categorySource: "manual" as const };
  const pattern = input.alwaysDoThis ? learnPattern(input.transaction.counterpartyNorm) : null;
  if (pattern === null) return { transaction, rule: null };

  const existing = input.rules.find(
    (r) => r.source === "learned" && r.match === "counterparty_prefix" && r.pattern === pattern,
  );
  const rule: CategoryRule = existing
    ? { ...existing, categoryId: input.categoryId }
    : { id: input.newId(), match: "counterparty_prefix", pattern, categoryId: input.categoryId, source: "learned" };
  return { transaction, rule };
}
