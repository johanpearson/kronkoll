/**
 * Kategorisering med deterministiska regler (KK-18, beslut D-rules).
 *
 * Prioritet: en manuellt satt kategori rörs aldrig (KK-18-C). Bland reglerna vinner en inlärd
 * över en mallregel. Bland de inlärda vinner den som står först i användarens ordning (KK-58-C), och
 * inlärda utan plats kommer efter dem. Annars gäller exakt matchning före prefix före text i
 * beskrivningen, sedan längre mönster. "Gör alltid så" lär in en regel på hela den normaliserade
 * motparten (KK-18-B).
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
  /** Platsen i användarens ordning, 0 först (KK-58-C). Bara för inlärda; saknas för en regel som inte ordnats. */
  readonly position?: number;
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

/**
 * Text som en Innehåller-regel söker i: versaler och ett mellanslag mellan orden, som mönstret sparas.
 * Banken kan skicka flera mellanslag eller en tabb mellan orden, och då missade regeln (#250).
 */
const searchable = (text: string) => text.replace(/\s+/gu, " ").toLocaleUpperCase("sv-SE");

function matchText(tx: Pick<CategorizableTransaction, "counterpartyNorm" | "description">): MatchText {
  return { key: ruleKey(tx), description: searchable(tx.description) };
}

function matches(rule: Pick<CategoryRule, "match" | "pattern">, text: MatchText): boolean {
  switch (rule.match) {
    case "counterparty_exact":
      return rule.pattern !== "" && text.key === rule.pattern;
    case "counterparty_prefix":
      return matchesWordPrefix(rule.pattern, text.key);
    case "description_contains":
      // Texten kan stå i motparten eller i beskrivningen, och versaler och gemener spelar ingen roll (KK-47-A).
      return rule.pattern !== "" && (text.description.includes(rule.pattern) || text.key.includes(rule.pattern));
  }
}

/** Platsen i användarens ordning. En regel utan plats kommer efter. Mallregler får aldrig någon (`orderRules`). */
const placeOf = (r: CategoryRule) => r.position ?? Infinity;

function byPriority(a: CategoryRule, b: CategoryRule): number {
  const place = placeOf(a) - placeOf(b);
  return (
    (a.source === "learned" ? 0 : 1) - (b.source === "learned" ? 0 : 1) ||
    (Number.isNaN(place) ? 0 : place) ||
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
  const text = matchText(tx);
  const rule = rules.filter((r) => matches(r, text)).sort(byPriority)[0];
  return rule ? { categoryId: rule.categoryId, source: rule.source, ruleId: rule.id } : null;
}

/** Bara villkoret i en regel: vad den träffar, inte vad den gör. */
export type RuleCondition = Pick<CategoryRule, "id" | "match" | "pattern">;

/**
 * Den regel som träffar transaktionen, med samma matchning och ordning som kategoriseringen (exakt före
 * prefix före text, längre mönster först), eller null. Används av regler som Räkna inte (KK-39-C).
 */
export function matchingRule(tx: Pick<CategorizableTransaction, "counterpartyNorm" | "description">, rules: readonly RuleCondition[]): string | null {
  if (rules.length === 0) return null;
  const text = matchText(tx);
  const hit = rules
    .filter((r) => matches(r, text))
    .sort((a, b) => MATCH_RANK[a.match] - MATCH_RANK[b.match] || b.pattern.length - a.pattern.length || (a.id < b.id ? -1 : 1))[0];
  return hit?.id ?? null;
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
  /**
   * En text som transaktionens motpart eller beskrivning ska innehålla, var som helst och oavsett versaler
   * (KK-47). Går före `pattern`. Texten måste finnas i transaktionen, så regeln inte gäller något annat.
   */
  readonly contains?: string;
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
  if (input.contains !== undefined) {
    const text = input.contains.trim().replace(/\s+/gu, " ").toLocaleUpperCase("sv-SE");
    const own = searchable(`${input.transaction.counterpartyNorm} ${input.transaction.description}`);
    if (text === "" || !own.includes(text)) throw new RangeError("Texten måste finnas i transaktionen");
    const known = input.rules.find((r) => r.source === "learned" && r.match === "description_contains" && r.pattern === text);
    const rule: CategoryRule = known
      ? { ...known, categoryId: input.categoryId }
      : { id: input.newId(), match: "description_contains", pattern: text, categoryId: input.categoryId, source: "learned" };
    return { transaction, rule };
  }
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

/**
 * Användarens ordning på de egna reglerna (KK-58-C): `order` är de inlärda reglernas id, den som ska vinna
 * först. Varje inlärd regel får sin plats, och mallreglerna lämnas som de är (de kommer alltid sist).
 */
export function orderRules(rules: readonly CategoryRule[], order: readonly string[]): CategoryRule[] {
  const learned = new Set(rules.filter((r) => r.source === "learned").map((r) => r.id));
  if (new Set(order).size !== order.length || order.length !== learned.size || order.some((id) => !learned.has(id))) {
    throw new RangeError("Ordningen måste innehålla varje egen regel en gång");
  }
  return rules.map((r) => (r.source === "learned" ? { ...r, position: order.indexOf(r.id) } : r));
}

export interface ReachOptions {
  /**
   * Skriv över även manuellt kategoriserade där regeln vinner (KK-58-B). Ett engångsval när regeln sparas: de
   * får regelns källa, och ett nytt manuellt val efter det skyddas som vanligt.
   */
  readonly overrideManual?: boolean;
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
export function ruleReach(transactions: readonly CategorizableTransaction[], rules: readonly CategoryRule[], ruleId: string, options: ReachOptions = {}): RuleReach {
  const changes: CategoryChange[] = [];
  let protectedManual = 0;
  for (const tx of transactions) {
    if (tx.categorySource === "manual") {
      const result = categorize({ ...tx, categorySource: "none" }, rules);
      if (result?.ruleId !== ruleId) continue;
      if (options.overrideManual === true) changes.push({ id: tx.id, categoryId: result.categoryId, categorySource: result.source });
      else protectedManual += 1;
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

export interface RuleMatch {
  readonly id: string;
  /** "change" får regelns kategori om den appliceras, "unchanged" har den redan, "manual" ändras aldrig. */
  readonly effect: "change" | "unchanged" | "manual";
}

/**
 * Transaktionerna en regel gäller, för förhandsvisningen innan den appliceras: där just den regeln vinner,
 * med manuellt valda inräknade men märkta (KK-18-C).
 */
export function ruleMatches(transactions: readonly CategorizableTransaction[], rules: readonly CategoryRule[], ruleId: string): RuleMatch[] {
  return transactions.flatMap((tx): RuleMatch[] => {
    const result = categorize({ ...tx, categorySource: "none" }, rules);
    if (result?.ruleId !== ruleId) return [];
    if (tx.categorySource === "manual") return [{ id: tx.id, effect: "manual" }];
    const same = result.categoryId === tx.categoryId && result.source === tx.categorySource;
    return [{ id: tx.id, effect: same ? "unchanged" : "change" }];
  });
}

/**
 * Alla regler över hela historiken, för "Applicera alla regler". Som `applyRules`, men en transaktion
 * som ingen regel träffar behåller sin kategori, så att en borttagen regel inte tömmer något.
 */
export function applyAllRules(transactions: readonly CategorizableTransaction[], rules: readonly CategoryRule[]): CategoryChange[] {
  return applyRules(transactions, rules).filter((c) => c.categoryId !== null);
}
