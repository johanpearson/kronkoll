// Lånet en betalning hör till (KK-59-B): "Lån: <namn>" på detaljsidan, och knappar för att koppla till ett lån eller
// koppla loss för hand med PUT /api/transactions/{id}/loan. En koppling för hand ändras aldrig av lånets kontouppgifter.
// Lånets namn är användarens text och renderas som text (KK-30).
import { useState } from "react";
import { field, getJson, putJson } from "../api.ts";
import { useToast } from "../toast.tsx";

export interface LinkedLoan {
  readonly id: string;
  readonly name: string;
  readonly source: "auto" | "manual";
}

/** Lånet ur transaktionens detalj, eller null utan koppling. */
export function toLinkedLoan(raw: unknown): LinkedLoan | null {
  const id = field(raw, "id");
  const name = field(raw, "name");
  if (typeof id !== "string" || typeof name !== "string") return null;
  return { id, name, source: field(raw, "source") === "manual" ? "manual" : "auto" };
}

/** "Bolån (vald av dig)" eller "Bolån (automatiskt)". */
export const loanLabel = (loan: LinkedLoan) => `${loan.name} (${loan.source === "manual" ? "vald av dig" : "automatiskt"})`;

export function LoanLink(props: { transactionId: string; loan: LinkedLoan | null; onSaved: () => void }) {
  const toast = useToast();
  const [loans, setLoans] = useState<readonly { id: string; name: string }[] | null>(null);
  const [chosen, setChosen] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (loanId: string | null) => {
    setBusy(true);
    setError(null);
    const { status } = await putJson(`/api/transactions/${encodeURIComponent(props.transactionId)}/loan`, { loan_id: loanId });
    setBusy(false);
    if (status !== 200) {
      setError("Det gick inte att spara kopplingen. Försök igen.");
      return;
    }
    toast.done(loanId === null ? "Betalningen är kopplad loss från lånet." : "Betalningen är kopplad till lånet.");
    setLoans(null);
    props.onSaved();
  };

  const choose = async () => {
    setError(null);
    const { status, body } = await getJson("/api/loans");
    const list = field(body, "loans");
    if (status !== 200 || !Array.isArray(list)) {
      setError("Det gick inte att hämta lånen. Försök igen.");
      return;
    }
    const options = list.flatMap((l) => {
      const id = field(l, "id");
      const name = field(l, "name");
      return typeof id === "string" && typeof name === "string" ? [{ id, name }] : [];
    });
    setLoans(options);
    setChosen(options[0]?.id ?? "");
  };

  return (
    <section className="card" aria-label="Lån">
      {error && <p role="alert">{error}</p>}
      {props.loan ? (
        <p className="actions">
          <button type="button" disabled={busy} onClick={() => void save(null)}>
            Koppla loss från lånet
          </button>
        </p>
      ) : loans === null ? (
        <p className="actions">
          <button type="button" disabled={busy} onClick={() => void choose()}>
            Koppla till lån
          </button>
        </p>
      ) : loans.length === 0 ? (
        <p>Lägg till lånet under Lån först.</p>
      ) : (
        <p className="actions">
          <label>
            Lån
            <select value={chosen} onChange={(e) => { setChosen(e.target.value); }}>
              {loans.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="primary" disabled={busy} onClick={() => void save(chosen)}>
            Koppla
          </button>
          <button type="button" onClick={() => { setLoans(null); }}>
            Avbryt
          </button>
        </p>
      )}
    </section>
  );
}
