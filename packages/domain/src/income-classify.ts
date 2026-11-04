/**
 * Klassning av inkomster som lön, föräldrapenning eller övrigt (KK-22-A).
 *
 * Använder samma regelmotor som kategoriseringen (`categorize`): samma matchning på `ruleKey`, och samma
 * prioritet (inlärd före mall, exakt före prefix före text, längre mönster först). Försäkringskassan och
 * "LÖN …" känns igen av mallregler. Arbetsgivarens namn lärs in när användaren ändrar klassningen.
 * Antagande A-6: hur Försäkringskassan och lönen syns hos banken är inte bekräftat med riktig data än.
 */
import { categorize, ruleKey, type CategoryRule } from "./categorize.ts";
import { learnPattern } from "./normalize.ts";

export type IncomeType = "salary" | "parental_benefit" | "other";
export type IncomeSource = "manual" | "learned" | "template" | "none";

export interface IncomeRule {
  readonly id: string;
  readonly match: CategoryRule["match"];
  /** Normaliserad text (versaler). */
  readonly pattern: string;
  readonly incomeType: IncomeType;
  readonly source: "learned" | "template";
}

export interface IncomeTransaction {
  readonly id: string;
  /** Positivt för inbetalningar. Bara de är inkomster. */
  readonly amountMinor: number;
  readonly counterpartyNorm: string;
  readonly description: string;
  readonly incomeType: IncomeType | null;
  readonly incomeSource: IncomeSource;
}

export interface IncomeClassification {
  readonly incomeType: IncomeType;
  readonly source: IncomeSource;
  readonly ruleId: string | null;
}

const templateRule = (id: string, pattern: string, incomeType: IncomeType): IncomeRule => ({
  id,
  match: "counterparty_prefix",
  pattern,
  incomeType,
  source: "template",
});

/** Mallregler. Banker skriver ibland utan å, ä och ö, så båda stavningarna finns. */
export const INCOME_TEMPLATE_RULES: readonly IncomeRule[] = [
  templateRule("inkomst-forsakringskassan", "FÖRSÄKRINGSKASSAN", "parental_benefit"),
  templateRule("inkomst-forsakringskassan-ascii", "FORSAKRINGSKASSAN", "parental_benefit"),
  templateRule("inkomst-lon", "LÖN", "salary"),
  templateRule("inkomst-lon-ascii", "LON", "salary"),
];

/** Inkomstreglerna i kategoriseringens form, så att `categorize` kan välja vinnaren. */
function asCategoryRules(rules: readonly IncomeRule[]): CategoryRule[] {
  return rules.map((r) => ({ id: r.id, match: r.match, pattern: r.pattern, categoryId: r.incomeType, source: r.source }));
}

function classifyWith(tx: IncomeTransaction, rules: readonly IncomeRule[], categoryRules: readonly CategoryRule[]): IncomeClassification | null {
  if (tx.amountMinor <= 0) return null;
  if (tx.incomeSource === "manual" && tx.incomeType !== null) {
    return { incomeType: tx.incomeType, source: "manual", ruleId: null };
  }
  const hit = categorize({ ...tx, categoryId: null, categorySource: "none" }, categoryRules);
  const rule = hit ? rules.find((r) => r.id === hit.ruleId) : undefined;
  return rule ? { incomeType: rule.incomeType, source: rule.source, ruleId: rule.id } : { incomeType: "other", source: "none", ruleId: null };
}

/**
 * Inkomsttypen för en transaktion, eller null om den inte är en inbetalning. En manuell klassning rörs
 * aldrig. En inbetalning som ingen regel känner igen, t.ex. en Swish, blir övrigt.
 */
export function classifyIncome(tx: IncomeTransaction, rules: readonly IncomeRule[]): IncomeClassification | null {
  return classifyWith(tx, rules, asCategoryRules(rules));
}

export interface IncomeChange {
  readonly id: string;
  readonly incomeType: IncomeType | null;
  readonly incomeSource: IncomeSource;
}

/** Räknar om klassningen bakåt, t.ex. efter en inlärd regel. Manuella rörs inte. Bara ändringar returneras. */
export function applyIncomeRules(transactions: readonly IncomeTransaction[], rules: readonly IncomeRule[]): IncomeChange[] {
  const categoryRules = asCategoryRules(rules);
  const changes: IncomeChange[] = [];
  for (const tx of transactions) {
    // En manuell klassning ger tillbaka sig själv och blir därför ingen ändring.
    const result = classifyWith(tx, rules, categoryRules);
    const incomeType = result?.incomeType ?? null;
    const incomeSource = result?.source ?? "none";
    if (incomeType !== tx.incomeType || incomeSource !== tx.incomeSource) {
      changes.push({ id: tx.id, incomeType, incomeSource });
    }
  }
  return changes;
}

export interface LearnIncomeInput {
  readonly transaction: IncomeTransaction;
  readonly incomeType: IncomeType;
  readonly rules: readonly IncomeRule[];
  readonly newId: () => string;
}

export interface LearnIncomeResult {
  readonly transaction: IncomeTransaction;
  /** Ny eller uppdaterad inlärd regel, eller null om transaktionen saknar namn att lära sig. */
  readonly rule: IncomeRule | null;
}

/**
 * Användaren ändrar klassningen. Ändringen blir manuell och lär alltid en regel på hela namnet (motparten,
 * annars meddelandet), så att nästa lön från samma arbetsgivare klassas likadant.
 */
export function learnIncomeFromManualChoice(input: LearnIncomeInput): LearnIncomeResult {
  if (input.transaction.amountMinor <= 0) throw new RangeError("Bara inbetalningar kan klassas som inkomst");
  const transaction = { ...input.transaction, incomeType: input.incomeType, incomeSource: "manual" as const };
  const pattern = learnPattern(ruleKey(input.transaction));
  if (pattern === null) return { transaction, rule: null };

  const existing = input.rules.find((r) => r.source === "learned" && r.match === "counterparty_prefix" && r.pattern === pattern);
  const rule: IncomeRule = existing
    ? { ...existing, incomeType: input.incomeType }
    : { id: input.newId(), match: "counterparty_prefix", pattern, incomeType: input.incomeType, source: "learned" };
  return { transaction, rule };
}
