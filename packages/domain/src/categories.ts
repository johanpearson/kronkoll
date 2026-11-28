/**
 * Kategorimallen och redigering av kategorier (KK-18-A, beslut D-cats: två nivåer).
 *
 * Mallen har 12 huvudkategorier för utgifter och överföringar plus Inkomst. Id:n är stabila
 * slugs, så att mallen kan seedas i en migrering och mallregler kan peka på dem.
 * Redigering är rena funktioner som returnerar det nya läget och vad som ändrats.
 */
import type { CategoryRule } from "./categorize.ts";

export type CategoryKind = "expense" | "income" | "transfer";

export interface Category {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly kind: CategoryKind;
  readonly archived: boolean;
  /** Platsen bland syskonen, lägst först. Saknas den visas kategorin efter de placerade, på namn (#251). */
  readonly position?: number;
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[åä]/gu, "a")
    .replace(/ö/gu, "o")
    .replace(/é/gu, "e")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
}

const TEMPLATE: readonly [string, CategoryKind, readonly string[]][] = [
  ["Boende", "expense", ["Hyra & avgift", "Låneränta", "El", "Bredband", "Hemförsäkring", "Underhåll"]],
  ["Mat", "expense", ["Livsmedel", "Restaurang & café", "Systembolaget"]],
  ["Transport", "expense", ["Kollektivtrafik", "Bil & bränsle", "Parkering", "Taxi"]],
  ["Barn", "expense", ["Mat & blöjor", "Kläder", "Förskola", "Aktiviteter"]],
  ["Hushåll", "expense", ["Förbrukning", "Möbler & inredning", "Elektronik"]],
  ["Hälsa", "expense", ["Apotek", "Vård", "Träning"]],
  ["Kläder", "expense", ["Vuxenkläder", "Skor", "Accessoarer"]],
  ["Nöje", "expense", ["Bio & evenemang", "Bar & uteliv", "Spel"]],
  ["Fritid", "expense", ["Hobby", "Sport", "Resor"]],
  ["Abonnemang", "expense", ["Streaming", "Mobil", "Tidningar", "Programvara"]],
  ["Sparande & överföringar", "transfer", ["Sparande", "Amortering", "Överföringar", "Kortfaktura"]],
  ["Övrigt", "expense", ["Avgifter", "Gåvor", "Övrigt"]],
  ["Inkomst", "income", ["Lön", "Föräldrapenning", "Övrigt"]],
];

export const CATEGORY_TEMPLATE: readonly Category[] = TEMPLATE.flatMap(([name, kind, subs]) => {
  const id = slug(name);
  return [
    { id, parentId: null, name, kind, archived: false },
    ...subs.map((sub) => ({ id: `${id}-${slug(sub)}`, parentId: id, name: sub, kind, archived: false })),
  ];
});

/** Vanliga svenska motparter. Normaliserade mönster, matchas som ordprefix. */
const TEMPLATE_PATTERNS: readonly [string, string][] = [
  ["ICA", "mat-livsmedel"],
  ["COOP", "mat-livsmedel"],
  ["WILLYS", "mat-livsmedel"],
  ["HEMKOP", "mat-livsmedel"],
  ["LIDL", "mat-livsmedel"],
  ["SYSTEMBOLAGET", "mat-systembolaget"],
  ["SL", "transport-kollektivtrafik"],
  ["APOTEKET", "halsa-apotek"],
  ["APOTEK", "halsa-apotek"],
  ["NETFLIX", "abonnemang-streaming"],
  ["NETFLIX.COM", "abonnemang-streaming"],
  ["SPOTIFY", "abonnemang-streaming"],
  ["FORSAKRINGSKASSAN", "inkomst-foraldrapenning"],
];

export const TEMPLATE_RULES: readonly CategoryRule[] = TEMPLATE_PATTERNS.map(([pattern, categoryId]) => ({
  id: `mall-${slug(pattern)}`,
  match: "counterparty_prefix",
  pattern,
  categoryId,
  source: "template",
}));

function get(categories: readonly Category[], id: string): Category {
  const category = categories.find((c) => c.id === id);
  if (!category) throw new RangeError(`Okänd kategori: ${id}`);
  return category;
}

function assertName(categories: readonly Category[], parentId: string | null, name: string, exceptId?: string): string {
  const trimmed = name.trim();
  if (trimmed === "") throw new RangeError("Kategorin måste ha ett namn");
  const lower = trimmed.toLocaleLowerCase("sv-SE");
  const taken = categories.some(
    (c) => c.parentId === parentId && !c.archived && c.id !== exceptId && c.name.toLocaleLowerCase("sv-SE") === lower,
  );
  if (taken) throw new RangeError(`Det finns redan en kategori som heter ${trimmed}`);
  return trimmed;
}

export function renameCategory(categories: readonly Category[], id: string, name: string): Category[] {
  const category = get(categories, id);
  const newName = assertName(categories, category.parentId, name, id);
  return categories.map((c) => (c.id === id ? { ...c, name: newName } : c));
}

export interface AddCategoryInput {
  readonly parentId: string | null;
  readonly name: string;
  readonly newId: () => string;
}

/** Lägger till en huvudkategori för utgifter, eller en underkategori som ärver typen. */
export function addCategory(
  categories: readonly Category[],
  input: AddCategoryInput,
): { categories: Category[]; category: Category } {
  let kind: CategoryKind = "expense";
  if (input.parentId !== null) {
    const parent = get(categories, input.parentId);
    if (parent.parentId !== null) throw new RangeError("Kategorier kan bara ha två nivåer");
    if (parent.archived) throw new RangeError("Huvudkategorin är arkiverad");
    kind = parent.kind;
  }
  const name = assertName(categories, input.parentId, input.name);
  const category: Category = { id: input.newId(), parentId: input.parentId, name, kind, archived: false };
  return { categories: [...categories, category], category };
}

/** Arkiverar en kategori och, för en huvudkategori, dess underkategorier. */
export function archiveCategory(categories: readonly Category[], id: string): Category[] {
  get(categories, id);
  return categories.map((c) => (c.id === id || c.parentId === id ? { ...c, archived: true } : c));
}

export interface MergeInput {
  readonly categories: readonly Category[];
  readonly fromId: string;
  readonly intoId: string;
  readonly transactions: readonly { readonly id: string; readonly categoryId: string | null }[];
  readonly rules: readonly CategoryRule[];
}

export interface MergeResult {
  readonly categories: Category[];
  readonly transactionChanges: { id: string; categoryId: string }[];
  readonly ruleChanges: CategoryRule[];
}

/**
 * Slår ihop två kategorier på samma nivå och av samma typ. Transaktioner och regler flyttas,
 * underkategorier till en huvudkategori följer med, och den gamla kategorin arkiveras.
 */
export function mergeCategories(input: MergeInput): MergeResult {
  const from = get(input.categories, input.fromId);
  const into = get(input.categories, input.intoId);
  if (from.id === into.id) throw new RangeError("En kategori kan inte slås ihop med sig själv");
  if ((from.parentId === null) !== (into.parentId === null)) throw new RangeError("Kategorierna måste ligga på samma nivå");
  if (from.kind !== into.kind) throw new RangeError("Kategorierna måste vara av samma typ");
  if (into.archived) throw new RangeError("Det går inte att slå ihop med en arkiverad kategori");

  const categories = input.categories.map((c) => {
    if (c.id === from.id) return { ...c, archived: true };
    if (c.parentId === from.id) return { ...c, parentId: into.id };
    return c;
  });
  return {
    categories,
    transactionChanges: input.transactions
      .filter((t) => t.categoryId === from.id)
      .map((t) => ({ id: t.id, categoryId: into.id })),
    ruleChanges: input.rules.filter((r) => r.categoryId === from.id).map((r) => ({ ...r, categoryId: into.id })),
  };
}

/** Syskon är kategorier med samma huvudkategori och typ, de som visas i samma lista. */
const isSibling = (a: Category, b: Category) => a.parentId === b.parentId && a.kind === b.kind;

/** Platsen som sortering går på: de utan plats kommer efter alla med plats. */
const placeOf = (c: Category) => c.position ?? Number.POSITIVE_INFINITY;

/** Kategorierna i visningsordning: de med plats först i sin ordning, sedan resten på namn (#251). */
export function sortCategories(categories: readonly Category[]): Category[] {
  return categories.toSorted((a, b) => (placeOf(a) < placeOf(b) ? -1 : placeOf(a) > placeOf(b) ? 1 : a.name.localeCompare(b.name, "sv")));
}

/**
 * Flyttar en kategori före en annan bland sina syskon, eller sist om `beforeId` är null (#251). Syskonen
 * numreras om från noll, så att ordningen blir fast även för dem som inte hade någon plats. Övriga
 * kategorier ändras inte. Arkiverade syskon räknas inte, eftersom de inte visas.
 */
export function moveCategory(categories: readonly Category[], id: string, beforeId: string | null): Category[] {
  const moving = get(categories, id);
  if (moving.archived) throw new RangeError("Kategorin är arkiverad");
  if (beforeId === id) throw new RangeError("En kategori kan inte flyttas före sig själv");
  const before = beforeId === null ? null : get(categories, beforeId);
  if (before !== null && (before.archived || !isSibling(moving, before))) {
    throw new RangeError("Kategorierna måste ligga på samma nivå och vara av samma typ");
  }
  const others = sortCategories(categories.filter((c) => !c.archived && c.id !== id && isSibling(moving, c)));
  const at = before === null ? others.length : others.findIndex((c) => c.id === before.id);
  const order = [...others.slice(0, at), moving, ...others.slice(at)].map((c) => c.id);
  return categories.map((c) => (order.includes(c.id) ? { ...c, position: order.indexOf(c.id) } : c));
}
