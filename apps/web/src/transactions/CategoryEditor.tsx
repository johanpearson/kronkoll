// Byta kategori på en transaktion (#32, KK-18-B, KK-18-C). Valet blir manuellt och rörs sedan aldrig
// av regler. Med "Gör alltid så" lärs en regel in, och om den matchar tidigare transaktioner frågar
// vyn om den ska gälla dem också. Manuellt valda ändras aldrig. Har namnet flera ord kan regeln gälla en
// kortare början, t.ex. "IKEA" för alla varuhus i kedjan, eller en text som namnet bara ska innehålla,
// t.ex. "amazon", oavsett versaler (KK-47). Standard är hela namnet.
import { normalizeCounterparty, patternChoices } from "@kronkoll/domain";
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
  /** Bankens text, som regeln byggs av. Samma normalisering som servern använder. */
  readonly counterparty: string;
  readonly description: string;
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
  const choices = patternChoices({ counterpartyNorm: normalizeCounterparty(props.counterparty), description: props.description });
  const [pattern, setPattern] = useState(choices[0] ?? "");
  /** Börjar med ett av valen, eller innehåller en text som användaren skriver. */
  const [kind, setKind] = useState<"prefix" | "contains">("prefix");
  const [contains, setContains] = useState(choices.at(-1)?.toLocaleLowerCase("sv-SE") ?? "");

  const save = async () => {
    setBusy(true);
    setError(null);
    const rule = !learn ? {} : kind === "contains" ? { rule_contains: contains } : choices.length > 1 ? { rule_pattern: pattern } : {};
    const request = { category_id: categoryId, learn_rule: learn, ...rule };
    const { status, body } = await patchJson(`/api/transactions/${encodeURIComponent(props.transactionId)}`, request);
    setBusy(false);
    if (status !== 200) {
      setError(field(body, "error") === "invalid_pattern" ? "Skriv en text som finns i transaktionen." : "Det gick inte att spara kategorin. Försök igen.");
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
      {learn && (
        <fieldset className="choices">
          <legend>Gäller</legend>
          {choices.length > 1 &&
            choices.map((c) => (
              <label key={c}>
                <input type="radio" name={`pattern-${props.transactionId}`} value={c} checked={kind === "prefix" && pattern === c} onChange={() => { setKind("prefix"); setPattern(c); }} />
                Allt som börjar med {c}
              </label>
            ))}
          <label>
            <input type="radio" name={`pattern-${props.transactionId}`} value="contains" checked={kind === "contains"} onChange={() => { setKind("contains"); }} />
            Allt som innehåller
          </label>
          {kind === "contains" && (
            <>
              <label>
                Text
                <input value={contains} maxLength={60} aria-describedby={`contains-hint-${props.transactionId}`} onChange={(e) => { setContains(e.target.value); }} />
              </label>
              <small id={`contains-hint-${props.transactionId}`}>Versaler och gemener spelar ingen roll.</small>
            </>
          )}
        </fieldset>
      )}
      {error && <p role="alert">{error}</p>}
      <p>
        <button type="button" className="primary" disabled={busy || categoryId === "" || (learn && kind === "contains" && contains.trim() === "")} onClick={() => void save()}>
          Spara
        </button>{" "}
        <button type="button" onClick={props.onClose}>
          Avbryt
        </button>
      </p>
    </div>
  );
}
