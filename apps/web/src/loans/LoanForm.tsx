// Lägg till eller ändra ett lån (#72, KK-36-A) i ett ark, i ny design (#257). Ett nytt lån får sitt id här och sparas
// med PUT /api/loans/{id}. Lånets kontouppgifter (KK-59-A), t.ex. kontonummer eller OCR, skrivs en per rad. Innan de
// sparas visar förhandsvisningen hur många betalningar de träffar. De sparas med PUT /api/loans/{id}/matching, som
// också kopplar hela historiken. Ett lån som ändras kan tas bort.
import { formatDateShort, formatSek } from "@kronkoll/domain";
import { useId, useState, type SyntheticEvent } from "react";
import { deleteJson, field, postJson, putJson } from "../api.ts";
import { parseKronor } from "../kronor.ts";
import { parsePercent } from "../percent.ts";
import { useToast } from "../toast.tsx";
import { Button } from "../ui/Button.tsx";
import type { Loan } from "./loan.ts";

/** Samma gränser som API:t. */
const MAX_PATTERNS = 10;
const MAX_PATTERN_LENGTH = 60;

const kronor = (ore: number) => (ore % 100 === 0 ? String(ore / 100) : (ore / 100).toFixed(2).replace(".", ","));
const percent = (bp: number) => String(bp / 100).replace(".", ",");
/** En text per rad, utan tomma rader. */
const linesOf = (text: string) => text.split("\n").map((l) => l.trim()).filter((l) => l !== "");
const samePatterns = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((p, i) => p === b[i]);

interface Example {
  readonly id: string;
  readonly date: string;
  readonly amountMinor: number;
  readonly text: string;
}

type Preview = { readonly count: number; readonly examples: readonly Example[] } | null;

function toExample(raw: unknown): Example | null {
  const id = field(raw, "id");
  const date = field(raw, "date");
  const amount = field(raw, "amount_minor");
  if (typeof id !== "string" || typeof date !== "string" || !Number.isSafeInteger(amount)) return null;
  const counterparty = field(raw, "counterparty");
  const description = field(raw, "description");
  const text = [counterparty, description].filter((t): t is string => typeof t === "string" && t !== "").join(" · ");
  return { id, date, amountMinor: amount as number, text };
}

function Field(props: { label: string; value: string; onChange: (value: string) => void; type?: string; inputMode?: "decimal"; maxLength?: number }) {
  const id = useId();
  return (
    <div className="ui-field">
      <label htmlFor={id} className="ui-label">
        {props.label}
      </label>
      <input id={id} className="ui-input" type={props.type ?? "text"} inputMode={props.inputMode} maxLength={props.maxLength} value={props.value} onChange={(e) => { props.onChange(e.target.value); }} />
    </div>
  );
}

export function LoanForm(props: { loan: Loan | null; onSaved: () => void; onClose: () => void }) {
  const toast = useToast();
  const l = props.loan;
  const patternsId = useId();
  const [name, setName] = useState(l?.name ?? "");
  const [lender, setLender] = useState(l?.lender ?? "");
  const [balance, setBalance] = useState(l ? kronor(l.balanceMinor) : "");
  const [rate, setRate] = useState(l ? percent(l.interestRateBp) : "");
  const [fixedUntil, setFixedUntil] = useState(l?.rateFixedUntil ?? "");
  const [amortization, setAmortization] = useState(l ? kronor(l.amortizationMinor) : "");
  const [patterns, setPatterns] = useState((l?.matchPatterns ?? []).join("\n"));
  const [preview, setPreview] = useState<Preview>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const patternProblem = (list: readonly string[]) =>
    list.length > MAX_PATTERNS || list.some((p) => p.length > MAX_PATTERN_LENGTH) ? "Skriv högst tio kontouppgifter, var och en på högst 60 tecken." : null;

  const showPreview = async () => {
    const list = linesOf(patterns);
    const problem = patternProblem(list);
    setError(problem);
    if (problem !== null) return;
    const { status, body } = await postJson("/api/loans/preview", { match_patterns: list });
    const examples = field(body, "examples");
    const count = field(body, "count");
    if (status !== 200 || !Array.isArray(examples) || !Number.isSafeInteger(count)) {
      setError("Det gick inte att visa träffarna. Försök igen.");
      return;
    }
    setPreview({ count: count as number, examples: examples.map(toExample).filter((e): e is Example => e !== null) });
  };

  const save = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const balanceMinor = parseKronor(balance);
    const ratePct = parsePercent(rate);
    const amortizationMinor = parseKronor(amortization);
    const list = linesOf(patterns);
    const problem =
      name.trim() === ""
        ? "Ge lånet ett namn, till exempel Bolån del 1."
        : balanceMinor === null || balance.trim() === ""
          ? "Skriv skulden i kronor, till exempel 1 200 000."
          : ratePct === null
            ? "Skriv räntan i procent, till exempel 3,5."
            : amortizationMinor === null
              ? "Skriv amorteringen i kronor per månad, eller 0."
              : patternProblem(list);
    setError(problem);
    if (problem !== null) return;
    setBusy(true);
    const id = l?.id ?? crypto.randomUUID();
    const path = `/api/loans/${encodeURIComponent(id)}`;
    const { status } = await putJson(path, {
      name: name.trim(),
      lender: lender.trim() === "" ? null : lender.trim(),
      balance_minor: balanceMinor,
      interest_rate_bp: Math.round((ratePct ?? 0) * 100),
      rate_fixed_until: fixedUntil === "" ? null : fixedUntil,
      amortization_minor: amortizationMinor,
    });
    if (status !== 200 && status !== 201) {
      setBusy(false);
      setError("Det gick inte att spara lånet. Försök igen.");
      return;
    }
    // Kontouppgifterna sparas bara när de ändrats, eftersom det kopplar om hela historiken. Ett lån som redan har en
    // kategori behåller den; annars väljer API:t Boende › Låneränta.
    let linked = 0;
    if (!samePatterns(list, l?.matchPatterns ?? [])) {
      const matching = await putJson(`${path}/matching`, l?.categoryId ? { match_patterns: list, category_id: l.categoryId } : { match_patterns: list });
      if (matching.status !== 200) {
        setBusy(false);
        setError("Lånet är sparat, men inte kontouppgifterna. Försök igen.");
        return;
      }
      const count = field(matching.body, "linked");
      linked = Number.isSafeInteger(count) ? (count as number) : 0;
    }
    setBusy(false);
    const saved = status === 201 ? "Lånet är sparat." : "Lånet är ändrat.";
    toast.done(linked > 0 ? `${saved} ${String(linked)} ${linked === 1 ? "betalning kopplades om" : "betalningar kopplades om"}.` : saved);
    props.onSaved();
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
    <form className="ui-stack" aria-label={l ? `Ändra ${l.name}` : "Nytt lån"} onSubmit={(e) => void save(e)}>
      <Field label="Namn" value={name} maxLength={60} onChange={setName} />
      <Field label="Långivare (valfritt)" value={lender} maxLength={60} onChange={setLender} />
      <Field label="Skuld (kr)" value={balance} inputMode="decimal" onChange={setBalance} />
      <Field label="Ränta (%)" value={rate} inputMode="decimal" onChange={setRate} />
      <Field label="Bunden till (tomt för rörlig ränta)" type="date" value={fixedUntil} onChange={setFixedUntil} />
      <Field label="Amortering (kr/mån)" value={amortization} inputMode="decimal" onChange={setAmortization} />
      <div className="ui-field">
        <label htmlFor={patternsId} className="ui-label">
          Kontouppgifter (valfritt)
        </label>
        <textarea
          id={patternsId}
          className="ui-input"
          rows={3}
          value={patterns}
          onChange={(e) => {
            setPatterns(e.target.value);
            setPreview(null);
          }}
        />
        <p className="ui-caption">Lånets kontonummer, OCR eller långivarens namn som det står i banken, en per rad. Betalningar som träffar kopplas till lånet och får kategorin Boende › Låneränta.</p>
        <Button variant="secondary" disabled={busy || linesOf(patterns).length === 0} onClick={() => void showPreview()}>
          Visa träffar
        </Button>
        {preview && (
          <div role="status" className="loan-preview">
            <p className="ui-body">{preview.count === 0 ? "Inga betalningar träffar." : `${String(preview.count)} ${preview.count === 1 ? "betalning träffar" : "betalningar träffar"}.`}</p>
            {preview.examples.length > 0 && (
              <ul className="loan-preview-list" aria-label="Exempel på träffar">
                {preview.examples.map((e) => (
                  <li key={e.id} className="ui-caption">{`${formatDateShort(e.date)} · ${formatSek(e.amountMinor)} · ${e.text}`}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      {error && (
        <p role="alert" className="ui-field-error">
          {error}
        </p>
      )}
      {confirming ? (
        <div className="ui-stack">
          <p className="ui-body">Ta bort lånet? Det försvinner ur lånöversikten och betalningarna kopplas loss. Inget hos banken ändras.</p>
          <Button variant="danger" block busy={busy} onClick={() => void remove()}>
            Ta bort
          </Button>
          <Button variant="quiet" block onClick={() => { setConfirming(false); }}>
            Behåll
          </Button>
        </div>
      ) : (
        <>
          <Button type="submit" variant="primary" block busy={busy}>
            Spara
          </Button>
          <Button variant="quiet" block onClick={props.onClose}>
            Avbryt
          </Button>
          {l && (
            <Button variant="danger" block onClick={() => { setConfirming(true); }}>
              Ta bort
            </Button>
          )}
        </>
      )}
    </form>
  );
}
