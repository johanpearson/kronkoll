// Förhandsvisning av en regel (#34, KK-18-C): transaktionerna regeln gäller och vad som händer med var och
// en om den appliceras. Manuellt valda märks och ändras aldrig. Bankens text visas som text (KK-30).
import { formatDateShort, formatSek } from "@kronkoll/domain";
import { useEffect, useState } from "react";
import { field, getJson } from "../api.ts";

interface Match {
  readonly id: string;
  readonly date: string;
  readonly name: string;
  readonly amountMinor: number;
  readonly effect: string;
}

interface Matches {
  readonly total: number;
  readonly change: number;
  readonly manual: number;
  readonly items: readonly Match[];
}

const EFFECT: Record<string, string> = {
  change: "Får kategorin",
  unchanged: "Har redan kategorin",
  manual: "Manuellt vald, ändras inte",
};

const count = (value: unknown) => (typeof value === "number" ? value : 0);

async function fetchMatches(ruleId: string): Promise<Matches | null> {
  const { status, body } = await getJson(`/api/rules/${encodeURIComponent(ruleId)}/matches`);
  const items = field(body, "items");
  if (status !== 200 || !Array.isArray(items)) return null;
  return {
    total: count(field(body, "total")),
    change: count(field(body, "change")),
    manual: count(field(body, "manual")),
    items: items.flatMap((raw): Match[] => {
      const id = field(raw, "id");
      const date = field(raw, "transaction_date");
      const amount = field(raw, "amount_minor");
      if (typeof id !== "string" || typeof date !== "string" || typeof amount !== "number") return [];
      const name = field(raw, "name");
      return [{ id, date, name: typeof name === "string" && name !== "" ? name : "Okänd motpart", amountMinor: amount, effect: String(field(raw, "effect")) }];
    }),
  };
}

export function RuleMatches({ ruleId }: { ruleId: string }) {
  const [matches, setMatches] = useState<Matches | null | "error">(null);

  useEffect(() => {
    let current = true;
    void fetchMatches(ruleId).then((loaded) => {
      if (current) setMatches(loaded ?? "error");
    });
    return () => {
      current = false;
    };
  }, [ruleId]);

  if (matches === null) return <p>Hämtar träffar…</p>;
  if (matches === "error") return <p role="alert">Det gick inte att hämta träffarna.</p>;
  if (matches.total === 0) return <p>Regeln träffar inga transaktioner än.</p>;

  return (
    <div className="rule-matches">
      <p>
        {matches.total} träffar: {matches.change} får kategorin
        {matches.manual > 0 ? `, ${String(matches.manual)} manuellt valda ändras inte` : ""}.
        {matches.items.length < matches.total ? ` Visar de ${String(matches.items.length)} senaste.` : ""}
      </p>
      <ul aria-label="Träffar">
        {matches.items.map((m) => (
          <li key={m.id} className={m.effect === "change" ? "tx" : "tx internal"}>
            <div className="tx-main">
              <span className="tx-name">{m.name}</span>
              <span className="amount">{formatSek(m.amountMinor)}</span>
            </div>
            <small className="tx-notes">
              {formatDateShort(m.date)} · {EFFECT[m.effect] ?? m.effect}
            </small>
          </li>
        ))}
      </ul>
    </div>
  );
}
