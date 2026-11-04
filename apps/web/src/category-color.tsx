// En färg per huvudkategori (KK-26-D). Färgen är bara en ledtråd bredvid namnet, aldrig det enda som
// visar kategorin. Mallens huvudkategorier har fasta färger. En egen huvudkategori får en färg utifrån
// sitt id, så att den är densamma varje gång. Underkategorier har huvudkategorins färg.
export const CATEGORY_COLORS = ["blue", "green", "orange", "pink", "violet", "teal", "brown", "gold", "olive", "plum", "slate", "grey", "lime"] as const;
type CategoryColor = (typeof CATEGORY_COLORS)[number];

const TEMPLATE: Readonly<Record<string, CategoryColor>> = {
  boende: "blue",
  mat: "green",
  transport: "orange",
  barn: "pink",
  hushall: "violet",
  halsa: "teal",
  klader: "brown",
  noje: "gold",
  fritid: "olive",
  abonnemang: "plum",
  "sparande-overforingar": "slate",
  ovrigt: "grey",
  inkomst: "lime",
};

export function categoryColor(categoryId: string, parentOf: ReadonlyMap<string, string | null>): CategoryColor {
  const main = parentOf.get(categoryId) ?? categoryId;
  const fixed = TEMPLATE[main];
  if (fixed) return fixed;
  let hash = 0;
  for (const char of main) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return CATEGORY_COLORS[hash % CATEGORY_COLORS.length] ?? "grey";
}

/** Den lilla pricken före kategorinamnet. Dold för skärmläsare, som läser namnet. */
export function CategoryDot(props: { categoryId: string; parentOf: ReadonlyMap<string, string | null> }) {
  return <span className={`cat-dot cat-${categoryColor(props.categoryId, props.parentOf)}`} aria-hidden="true" />;
}
