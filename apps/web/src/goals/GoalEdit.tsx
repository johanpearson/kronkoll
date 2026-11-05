// Ändra eller ta bort ett sparmål (KK-21-C). Källa och konto går inte att byta; då skapas ett nytt mål.
// Borttagning frågar först och tar med avsättningarna, men inget hos banken ändras.
import { useState, type SyntheticEvent } from "react";
import { deleteJson, field, patchJson } from "../api.ts";
import { navigate } from "../router.tsx";
import { useToast } from "../toast.tsx";
import { toGoal, type Goal } from "./goals.ts";
import { parseKronor } from "./NewGoal.tsx";

const kronor = (minor: number) => (minor % 100 === 0 ? String(minor / 100) : (minor / 100).toFixed(2).replace(".", ","));

export function GoalEdit(props: { goal: Goal; onSaved: (goal: Goal) => void; onClose: () => void }) {
  const toast = useToast();
  const g = props.goal;
  const [name, setName] = useState(g.name);
  const [target, setTarget] = useState(kronor(g.targetMinor));
  const [date, setDate] = useState(g.targetDate ?? "");
  const [initial, setInitial] = useState(kronor(g.initialMinor));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const path = `/api/goals/${encodeURIComponent(g.id)}`;

  const save = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const targetMinor = parseKronor(target);
    const initialMinor = parseKronor(initial);
    const problem =
      name.trim() === ""
        ? "Ge målet ett namn."
        : targetMinor === null || targetMinor <= 0
          ? "Skriv målbeloppet i kronor, till exempel 60 000."
          : g.source === "manual" && initialMinor === null
            ? "Skriv hur mycket som redan är sparat, eller 0."
            : null;
    setError(problem);
    if (problem !== null) return;
    setBusy(true);
    const { status, body } = await patchJson(path, {
      name: name.trim(),
      target_minor: targetMinor,
      target_date: date === "" ? null : date,
      ...(g.source === "manual" ? { initial_minor: initialMinor } : {}),
    });
    setBusy(false);
    const saved = status === 200 ? toGoal(body) : null;
    if (saved) {
      toast.done("Sparmålet är ändrat.");
      props.onSaved(saved);
    } else setError(field(body, "error") === "target_date_in_past" ? "Måldatum måste vara efter i dag." : "Det gick inte att spara. Försök igen.");
  };

  const remove = async () => {
    setBusy(true);
    const { status } = await deleteJson(path);
    setBusy(false);
    if (status === 204) {
      toast.done("Sparmålet är borttaget.");
      navigate("/sparmal");
    } else setError("Det gick inte att ta bort sparmålet. Försök igen.");
  };

  return (
    <form className="card goal-form" aria-label={`Ändra ${g.name}`} onSubmit={(e) => void save(e)}>
      <label>
        Namn
        <input value={name} maxLength={60} onChange={(e) => { setName(e.target.value); }} />
      </label>
      <label>
        Målbelopp (kr)
        <input value={target} inputMode="decimal" onChange={(e) => { setTarget(e.target.value); }} />
      </label>
      <label>
        Måldatum (valfritt)
        <input type="date" value={date} onChange={(e) => { setDate(e.target.value); }} />
      </label>
      {g.source === "manual" && (
        <label>
          Redan sparat innan avsättningarna (kr)
          <input value={initial} inputMode="decimal" onChange={(e) => { setInitial(e.target.value); }} />
        </label>
      )}
      {error && <p role="alert">{error}</p>}
      {confirming ? (
        <div className="tx-editor">
          <p>Ta bort sparmålet? Avsättningarna försvinner också. Inget hos banken ändras.</p>
          <p className="actions">
            <button type="button" className="danger" disabled={busy} onClick={() => void remove()}>
              Ta bort sparmål
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
          <button type="button" className="danger" onClick={() => { setConfirming(true); }}>
            Ta bort sparmål
          </button>
        </p>
      )}
    </form>
  );
}
