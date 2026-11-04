// Ta bort en periods budget (KK-40). Frågan säger vad som tas bort och vad som inte ändras, och
// ingenting händer förrän användaren bekräftar. Utfallet och andra perioder rörs aldrig.
import { useState } from "react";
import { deleteJson } from "../api.ts";

export function DeleteBudget(props: { periodKey: string; lineCount: number; onDeleted: () => void }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    setBusy(true);
    setError(null);
    const { status } = await deleteJson(`/api/budgets/${encodeURIComponent(props.periodKey)}`);
    setBusy(false);
    if (status === 204) props.onDeleted();
    else setError("Det gick inte att ta bort budgeten. Ingenting är ändrat. Försök igen.");
  };

  if (!asking) {
    return (
      <p>
        <button type="button" className="danger" onClick={() => { setAsking(true); }}>
          Ta bort budget
        </button>
      </p>
    );
  }
  const categories = `${String(props.lineCount)} ${props.lineCount === 1 ? "kategori" : "kategorier"}`;
  return (
    <section className="card tx-editor" aria-label="Ta bort budgeten">
      <h2>Ta bort budgeten för perioden?</h2>
      <p>Budgeten för {categories} tas bort. Utfallet och transaktionerna ändras inte, och andra perioder påverkas inte.</p>
      {error && <p role="alert">{error}</p>}
      <p>
        <button type="button" className="danger" disabled={busy} onClick={() => void remove()}>
          {busy ? "Tar bort…" : "Ta bort budget"}
        </button>
        <button type="button" disabled={busy} onClick={() => { setAsking(false); }}>
          Avbryt
        </button>
      </p>
    </section>
  );
}
