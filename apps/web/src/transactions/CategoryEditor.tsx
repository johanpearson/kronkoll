// Byta kategori på en transaktion (#32, KK-18-B, KK-18-C). Valet blir manuellt och rörs sedan aldrig
// av regler. Med "Gör alltid så" lärs en regel in, och om den matchar tidigare transaktioner frågar
// vyn om den ska gälla dem också. Manuellt valda ändras aldrig.
import { useState } from "react";
import { field, patchJson, postJson } from "../api.ts";

export interface CategoryOption {
  readonly id: string;
  readonly label: string;
}

type Step = { readonly kind: "choose" } | { readonly kind: "ask"; readonly ruleId: string; readonly candidates: number; readonly protectedManual: number };

export function CategoryEditor(props: {
  readonly transactionId: string;
  readonly name: string;
  readonly options: readonly CategoryOption[];
  /** Kategorin är sparad på transaktionen. */
  readonly onSaved: (categoryId: string) => void;
  /** En regel har applicerats bakåt på så många transaktioner, så listan behöver hämtas om. */
  readonly onApplied: (updated: number) => void;
  readonly onClose: () => void;
}) {
  const [categoryId, setCategoryId] = useState("");
  const [learn, setLearn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>({ kind: "choose" });

  const save = async () => {
    setBusy(true);
    setError(null);
    const { status, body } = await patchJson(`/api/transactions/${encodeURIComponent(props.transactionId)}`, { category_id: categoryId, learn_rule: learn });
    setBusy(false);
    if (status !== 200) {
      setError("Det gick inte att spara kategorin. Försök igen.");
      return;
    }
    props.onSaved(categoryId);
    const ruleId = field(field(body, "rule"), "id");
    const candidates = field(body, "retroactive_candidates");
    const protectedManual = field(body, "protected_manual");
    if (typeof ruleId === "string" && typeof candidates === "number" && candidates > 0) {
      setStep({ kind: "ask", ruleId, candidates, protectedManual: typeof protectedManual === "number" ? protectedManual : 0 });
    } else {
      props.onClose();
    }
  };

  const apply = async (ruleId: string) => {
    setBusy(true);
    setError(null);
    const { status, body } = await postJson(`/api/rules/${encodeURIComponent(ruleId)}/apply`, {});
    setBusy(false);
    const updated = field(body, "updated");
    if (status !== 200 || typeof updated !== "number") {
      setError("Det gick inte att applicera regeln. Försök igen.");
      return;
    }
    props.onApplied(updated);
  };

  if (step.kind === "ask") {
    const manual = step.protectedManual > 0 ? ` ${String(step.protectedManual)} manuellt valda ändras inte.` : "";
    return (
      <div>
        <p>
          Regeln matchar {step.candidates} tidigare transaktioner.{manual}
        </p>
        {error && <p role="alert">{error}</p>}
        <button type="button" disabled={busy} onClick={() => void apply(step.ruleId)}>
          Applicera på dem
        </button>{" "}
        <button type="button" disabled={busy} onClick={props.onClose}>
          Inte nu
        </button>
      </div>
    );
  }

  return (
    <div>
      <label>
        Kategori{" "}
        <select value={categoryId} onChange={(e) => { setCategoryId(e.target.value); }}>
          <option value="">Välj kategori</option>
          {props.options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </label>{" "}
      <label>
        <input type="checkbox" checked={learn} onChange={(e) => { setLearn(e.target.checked); }} /> Gör alltid så för {props.name}
      </label>
      {error && <p role="alert">{error}</p>}
      <p>
        <button type="button" disabled={busy || categoryId === ""} onClick={() => void save()}>
          Spara
        </button>{" "}
        <button type="button" onClick={props.onClose}>
          Avbryt
        </button>
      </p>
    </div>
  );
}
