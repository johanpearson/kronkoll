// Börja om med kategorierna (KK-48): rensa alla kategorier och regler som sätter en kategori och bygg upp nya
// från början, eller sätt tillbaka mallen. Appen räknar först hur mycket som berörs och frågar. Transaktionerna
// blir okategoriserade men raderas aldrig, och inget hos banken ändras.
import { useState } from "react";
import { field, postJson } from "../api.ts";
import { useToast } from "../toast.tsx";

interface Summary {
  readonly categories: number;
  readonly rules: number;
  readonly transactions: number;
  readonly splits: number;
  readonly budgetLines: number;
}

const count = (value: unknown) => (Number.isSafeInteger(value) ? (value as number) : null);

function toSummary(body: unknown): Summary | null {
  const [categories, rules, transactions, splits, budgetLines] = ["categories", "rules", "transactions", "splits", "budget_lines"].map((k) => count(field(body, k)));
  return categories === null || rules === null || transactions === null || splits === null || budgetLines === null
    ? null
    : { categories: categories ?? 0, rules: rules ?? 0, transactions: transactions ?? 0, splits: splits ?? 0, budgetLines: budgetLines ?? 0 };
}

export function ResetCategories(props: { onDone: () => void }) {
  const toast = useToast();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [template, setTemplate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ask = async () => {
    setBusy(true);
    setError(null);
    const { status, body } = await postJson("/api/categories/reset", { preview: true });
    setBusy(false);
    const next = status === 200 ? toSummary(body) : null;
    if (next) setSummary(next);
    else setError("Det gick inte att räkna vad som berörs. Försök igen.");
  };

  const reset = async () => {
    setBusy(true);
    setError(null);
    const { status } = await postJson("/api/categories/reset", { confirm: true, restore_template: template });
    setBusy(false);
    if (status === 200) {
      setSummary(null);
      toast.done(template ? "Kategorierna är återställda till mallen." : "Alla kategorier är rensade. Lägg till nya från början.");
      props.onDone();
    } else {
      setError("Det gick inte att rensa. Ingenting är ändrat. Försök igen.");
    }
  };

  if (summary === null) {
    return (
      <section className="card" aria-label="Börja om med kategorierna">
        <h2>Börja om</h2>
        <p>Rensa alla kategorier och regler och sätt upp nya från början.</p>
        {error && <p role="alert">{error}</p>}
        <p>
          <button type="button" disabled={busy} onClick={() => void ask()}>
            Rensa alla kategorier
          </button>
        </p>
      </section>
    );
  }
  return (
    <section className="card" role="region" aria-label="Rensa alla kategorier">
      <h2>Rensa alla kategorier?</h2>
      <p>
        {summary.categories} kategorier och {summary.rules} regler tas bort, {summary.transactions} transaktioner blir okategoriserade, {summary.splits} uppdelningar och{" "}
        {summary.budgetLines} budgetrader tas bort. Inga transaktioner raderas och inget hos banken ändras. Det går inte att ångra.
      </p>
      <label className="check">
        <input type="checkbox" checked={template} onChange={(e) => { setTemplate(e.target.checked); }} />
        Sätt tillbaka mallens kategorier och regler i stället för en tom lista
      </label>
      {error && <p role="alert">{error}</p>}
      <p className="actions">
        <button type="button" className="danger" disabled={busy} onClick={() => void reset()}>
          Rensa alla kategorier
        </button>
        <button type="button" disabled={busy} onClick={() => { setSummary(null); }}>
          Avbryt
        </button>
      </p>
    </section>
  );
}
