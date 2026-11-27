// Ta bort alla regler och börja om (KK-51): alla kategoriserande regler, mallens och egna, och alla Räkna inte-regler.
// Appen räknar först hur många som berörs och frågar. Transaktionerna behåller sin kategori, och det som en
// Räkna inte-regel höll utanför räknas igen.
import { useState } from "react";
import { field, postJson } from "../api.ts";
import { useToast } from "../toast.tsx";

export function ResetRules(props: { onDone: () => void }) {
  const toast = useToast();
  const [counts, setCounts] = useState<{ rules: number; exclude: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ask = async () => {
    setBusy(true);
    setError(null);
    const { status, body } = await postJson("/api/rules/reset", { preview: true });
    setBusy(false);
    const rules = field(body, "rules");
    const exclude = field(body, "exclude_rules");
    if (status === 200 && typeof rules === "number" && typeof exclude === "number") setCounts({ rules, exclude });
    else setError("Det gick inte att räkna reglerna. Försök igen.");
  };

  const reset = async () => {
    setBusy(true);
    setError(null);
    const { status } = await postJson("/api/rules/reset", { confirm: true });
    setBusy(false);
    if (status === 200) {
      setCounts(null);
      toast.done("Alla regler är borttagna.");
      props.onDone();
    } else {
      setError("Det gick inte att ta bort reglerna. Ingenting är ändrat. Försök igen.");
    }
  };

  if (counts === null) {
    return (
      <section className="card" aria-label="Ta bort alla regler">
        <h2>Börja om</h2>
        <p>Ta bort alla regler och sätt upp egna från början.</p>
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
        {counts.rules} regler som ger en kategori och {counts.exclude} regler som gör att något inte räknas tas bort. Transaktionerna behåller sin kategori, och det som reglerna höll utanför räknas igen.
        Det går inte att ångra.
      </p>
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
