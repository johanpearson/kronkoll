// Lägg till eller ändra ett lån (#72, KK-36-A). Ett nytt lån får sitt id här och sparas med PUT
// /api/loans/{id}. Ett lån som ändras kan också tas bort.
import { useState, type SyntheticEvent } from "react";
import { deleteJson, putJson } from "../api.ts";
import { parseKronor } from "../goals/NewGoal.tsx";
import { parsePercent } from "../income/NewLeave.tsx";
import { useToast } from "../toast.tsx";
import type { Loan } from "./loan.ts";

const kronor = (ore: number) => (ore % 100 === 0 ? String(ore / 100) : (ore / 100).toFixed(2).replace(".", ","));
const percent = (bp: number) => String(bp / 100).replace(".", ",");

export function LoanForm(props: { loan: Loan | null; onSaved: () => void; onClose: () => void }) {
  const toast = useToast();
  const l = props.loan;
  const [name, setName] = useState(l?.name ?? "");
  const [lender, setLender] = useState(l?.lender ?? "");
  const [balance, setBalance] = useState(l ? kronor(l.balanceMinor) : "");
  const [rate, setRate] = useState(l ? percent(l.interestRateBp) : "");
  const [fixedUntil, setFixedUntil] = useState(l?.rateFixedUntil ?? "");
  const [amortization, setAmortization] = useState(l ? kronor(l.amortizationMinor) : "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const save = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const balanceMinor = parseKronor(balance);
    const ratePct = parsePercent(rate);
    const amortizationMinor = parseKronor(amortization);
    const problem =
      name.trim() === ""
        ? "Ge lånet ett namn, till exempel Bolån del 1."
        : balanceMinor === null || balance.trim() === ""
          ? "Skriv skulden i kronor, till exempel 1 200 000."
          : ratePct === null
            ? "Skriv räntan i procent, till exempel 3,5."
            : amortizationMinor === null
              ? "Skriv amorteringen i kronor per månad, eller 0."
              : null;
    setError(problem);
    if (problem !== null) return;
    setBusy(true);
    const id = l?.id ?? crypto.randomUUID();
    const { status } = await putJson(`/api/loans/${encodeURIComponent(id)}`, {
      name: name.trim(),
      lender: lender.trim() === "" ? null : lender.trim(),
      balance_minor: balanceMinor,
      interest_rate_bp: Math.round((ratePct ?? 0) * 100),
      rate_fixed_until: fixedUntil === "" ? null : fixedUntil,
      amortization_minor: amortizationMinor,
    });
    setBusy(false);
    if (status === 200 || status === 201) {
      toast.done(status === 201 ? "Lånet är sparat." : "Lånet är ändrat.");
      props.onSaved();
    } else setError("Det gick inte att spara lånet. Försök igen.");
  };

  const remove = async () => {
    if (!l) return;
    setBusy(true);
    const { status } = await deleteJson(`/api/loans/${encodeURIComponent(l.id)}`);
    setBusy(false);
    if (status === 204) {
      toast.done("Lånet är borttaget.");
      props.onSaved();
    } else setError("Det gick inte att ta bort lånet. Försök igen.");
  };

  return (
    <form className="goal-form" aria-label={l ? `Ändra ${l.name}` : "Nytt lån"} onSubmit={(e) => void save(e)}>
      <label>
        Namn
        <input value={name} maxLength={60} onChange={(e) => { setName(e.target.value); }} />
      </label>
      <label>
        Långivare (valfritt)
        <input value={lender} maxLength={60} onChange={(e) => { setLender(e.target.value); }} />
      </label>
      <label>
        Skuld (kr)
        <input value={balance} inputMode="decimal" onChange={(e) => { setBalance(e.target.value); }} />
      </label>
      <label>
        Ränta (%)
        <input value={rate} inputMode="decimal" onChange={(e) => { setRate(e.target.value); }} />
      </label>
      <label>
        Bunden till (tomt för rörlig ränta)
        <input type="date" value={fixedUntil} onChange={(e) => { setFixedUntil(e.target.value); }} />
      </label>
      <label>
        Amortering (kr/mån)
        <input value={amortization} inputMode="decimal" onChange={(e) => { setAmortization(e.target.value); }} />
      </label>
      {error && <p role="alert">{error}</p>}
      {confirming ? (
        <div className="tx-editor">
          <p>Ta bort lånet? Det försvinner ur lånöversikten. Inget hos banken ändras.</p>
          <p className="actions">
            <button type="button" className="danger" disabled={busy} onClick={() => void remove()}>
              Ta bort
            </button>
            <button type="button" onClick={() => { setConfirming(false); }}>
              Behåll
            </button>
          </p>
        </div>
      ) : (
      <p className="actions">
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Sparar…" : "Spara"}
        </button>
        <button type="button" onClick={props.onClose}>
          Avbryt
        </button>
        {l && (
          <button type="button" className="danger" onClick={() => { setConfirming(true); }}>
            Ta bort
          </button>
        )}
      </p>
      )}
    </form>
  );
}
