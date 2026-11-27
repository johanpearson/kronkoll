// Ta bort alla regler och börja om (KK-51): alla kategoriserande regler, mallens och egna, och alla Räkna inte-regler.
// Appen räknar först hur många som berörs och frågar. Användaren väljer om transaktionerna behåller sin kategori,
// tappar den som reglerna satt eller tappar alla, även egna val. Det som en Räkna inte-regel höll utanför räknas igen.
import { useState } from "react";
import { field, postJson } from "../api.ts";
import { useToast } from "../toast.tsx";

export function ResetRules(props: { onDone: () => void }) {
  const toast = useToast();
  const [counts, setCounts] = useState<{ rules: number; exclude: number; byRules: number; all: number } | null>(null);
  const [uncategorize, setUncategorize] = useState<"none" | "rules" | "all">("rules");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ask = async () => {
    setBusy(true);
    setError(null);
    const { status, body } = await postJson("/api/rules/reset", { preview: true });
    setBusy(false);
    const rules = field(body, "rules");
    const exclude = field(body, "exclude_rules");
    const byRules = field(body, "categorized_by_rules");
    const all = field(body, "categorized");
    if (status === 200 && typeof rules === "number" && typeof exclude === "number") {
      setCounts({ rules, exclude, byRules: typeof byRules === "number" ? byRules : 0, all: typeof all === "number" ? all : 0 });
    } else {
      setError("Det gick inte att räkna reglerna. Försök igen.");
    }
  };
  const options = (c: { byRules: number; all: number }) => [
    { value: "rules", label: `Ta även bort kategorin som regler har satt (${String(c.byRules)} transaktioner)` },
    { value: "all", label: `Ta bort alla kategorier på transaktionerna, även de du valt själv (${String(c.all)})` },
    { value: "none", label: "Låt transaktionerna behålla sina kategorier" },
  ] as const;

  const reset = async () => {
    setBusy(true);
    setError(null);
    const { status } = await postJson("/api/rules/reset", { confirm: true, uncategorize });
    setBusy(false);
    if (status === 200) {
      setCounts(null);
      toast.done(uncategorize === "none" ? "Alla regler är borttagna." : "Alla regler är borttagna och transaktionerna är okategoriserade.");
      props.onDone();
    } else {
      setError("Det gick inte att ta bort reglerna. Ingenting är ändrat. Försök igen.");
    }
  };

  if (counts === null) {
    return (
      <section className="card" aria-label="Ta bort alla regler">
        <h2>Börja om</h2>
        <p>Ta bort alla regler, och om du vill kategorierna på transaktionerna, och sätt upp egna från början.</p>
        {error && <p role="alert">{error}</p>}
        <p>
          <button type="button" disabled={busy} onClick={() => void ask()}>
            Ta bort alla regler
          </button>
        </p>
      </section>
    );
  }
  return (
    <section className="card" role="region" aria-label="Ta bort alla regler?">
      <h2>Ta bort alla regler?</h2>
      <p>
        {counts.rules} regler som ger en kategori och {counts.exclude} regler som gör att något inte räknas tas bort. Det som reglerna höll utanför räknas igen. Det går inte att ångra.
      </p>
      <fieldset className="choices">
        <legend>Kategorierna på transaktionerna</legend>
        {options(counts).map((o) => (
          <label key={o.value}>
            <input type="radio" name="uncategorize" value={o.value} checked={uncategorize === o.value} onChange={() => { setUncategorize(o.value); }} />
            {o.label}
          </label>
        ))}
      </fieldset>
      {error && <p role="alert">{error}</p>}
      <p className="actions">
        <button type="button" className="danger" disabled={busy} onClick={() => void reset()}>
          Ta bort alla regler
        </button>
        <button type="button" disabled={busy} onClick={() => { setCounts(null); }}>
          Avbryt
        </button>
      </p>
    </section>
  );
}
