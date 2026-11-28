// Träffarna för en regel (#251, KK-18-C, KK-58-B): tolkningen av API:ts svar, en mening som sammanfattar dem och listan med
// transaktionerna. Används av formuläret, som visar några exempel medan man skriver, och av Visa träffar, som listar de
// senaste. Bankens text visas som text (KK-30).
import { formatDateShort, formatSek } from "@kronkoll/domain";
import { field } from "../api.ts";
import { List, ListRow } from "../ui/ListRow.tsx";

export interface Hit {
  readonly id: string;
  readonly date: string;
  readonly name: string;
  readonly amountMinor: number;
  readonly effect: string;
}

/** Träffarna med antal per vad som händer, och de första som lista. `total` räknas på alla. */
export interface Hits {
  readonly total: number;
  readonly change: number;
  readonly unchanged: number;
  readonly manual: number;
  readonly items: readonly Hit[];
}

const EFFECT: Record<string, string> = {
  change: "Får kategorin",
  unchanged: "Har redan kategorin",
  manual: "Manuellt vald, ändras inte",
};

const count = (value: unknown) => (typeof value === "number" ? value : 0);

/** Träffarna i ett svar med `total`, `change`, `unchanged`, `manual` och `items`, eller null om svaret inte har dem. */
export function toHits(value: unknown): Hits | null {
  const items = field(value, "items");
  if (!Array.isArray(items)) return null;
  return {
    total: count(field(value, "total")),
    change: count(field(value, "change")),
    unchanged: count(field(value, "unchanged")),
    manual: count(field(value, "manual")),
    items: items.flatMap((raw): Hit[] => {
      const id = field(raw, "id");
      const date = field(raw, "transaction_date");
      const amount = field(raw, "amount_minor");
      if (typeof id !== "string" || typeof date !== "string" || typeof amount !== "number") return [];
      const name = field(raw, "name");
      return [{ id, date, name: typeof name === "string" && name !== "" ? name : "Okänd motpart", amountMinor: amount, effect: String(field(raw, "effect")) }];
    }),
  };
}

/** Sammanfattningen av träffarna i en mening: bara det som inte är noll. */
export function summary(h: Hits): string {
  if (h.total === 0) return "Regeln träffar inga transaktioner än.";
  const parts = [
    h.change > 0 ? `${String(h.change)} får kategorin` : null,
    h.unchanged > 0 ? `${String(h.unchanged)} har redan kategorin` : null,
    h.manual > 0 ? `${String(h.manual)} är manuellt valda` : null,
  ].filter((part) => part !== null);
  return `Regeln träffar ${String(h.total)} transaktioner: ${parts.join(", ")}.`;
}

/** Transaktionerna som rader: motpart, datum och vad som händer, och beloppet. */
export function HitList(props: { label: string; hits: readonly Hit[] }) {
  return (
    <List label={props.label}>
      {props.hits.map((hit) => (
        <ListRow key={hit.id} label={hit.name} detail={`${formatDateShort(hit.date)} · ${EFFECT[hit.effect] ?? hit.effect}`} value={formatSek(hit.amountMinor)} />
      ))}
    </List>
  );
}
