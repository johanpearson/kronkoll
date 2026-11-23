// Riktlinjer och sparläge (KK-42): vad hushållet kan spendera, med tre lägen: ingen budget (bara
// riktlinjer), budget (taken under Budget) eller sparläge, där ett sparmål per period räknas av först och
// resten av inkomsten efter fasta kostnader blir det fria utrymmet. Läget gäller tills det stängs av. Per
// kategori visas historiskt snitt, normalt (median, utan engångsperioder) och sparläge, och varje nivå går
// att ändra för hand. Överskridet syns med text, inte bara färg (KK-42-D).
import { formatSek } from "@kronkoll/domain";
import { useEffect, useState, type SyntheticEvent } from "react";
import { AccountFilter, useAccountChoices } from "../accounts/account-filter.tsx";
import { putJson } from "../api.ts";
import { parseField, toText } from "../budget/BudgetEditor.tsx";
import { PeriodNav } from "../icon-button.tsx";
import { Link } from "../router.tsx";
import { useToast } from "../toast.tsx";
import { fetchCategories, NO_CATEGORIES, shiftPeriodKey, type Categories } from "../transactions/TransactionsView.tsx";
import { ExportSection } from "./ExportSection.tsx";
import { fetchGuidelines, type Guidelines, type Mode } from "./guidelines.ts";

const MODES: readonly { readonly mode: Mode; readonly label: string; readonly hint: string }[] = [
  { mode: "none", label: "Ingen budget – bara riktlinjer", hint: "Du ser vad ni brukar lägga, utan tak." },
  { mode: "budget", label: "Budget", hint: "Taken du satt under Budget gäller." },
  { mode: "saving", label: "Sparläge", hint: "Ett sparmål räknas av först, och resten är det ni kan spendera fritt." },
];

/** Hur många av de tidigare perioderna normalnivån räknas på (samma som domänens NORMAL_MONTHS). */
const HISTORY = 6;

const MONTH = new Intl.DateTimeFormat("sv-SE", { month: "long", year: "numeric", timeZone: "UTC" });
const monthName = (key: string) => MONTH.format(new Date(`${key}-01T00:00:00Z`));

function GuidelinesForm(props: { guidelines: Guidelines; categories: Categories; onSaved: () => void }) {
  const g = props.guidelines;
  const toast = useToast();
  const [mode, setMode] = useState<Mode>(g.mode);
  const [goal, setGoal] = useState(g.savingGoalMinor === 0 ? "" : toText(g.savingGoalMinor));
  const [levels, setLevels] = useState<ReadonlyMap<string, string>>(() => new Map(g.categories.flatMap((c) => (c.overrideMinor === null ? [] : [[c.categoryId, toText(c.overrideMinor)] as const]))));
  const [oneOff, setOneOff] = useState<ReadonlySet<string>>(new Set(g.oneOffPeriods));
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameOf = (id: string) => props.categories.names.get(id) ?? id;
  const saving = g.mode === "saving";
  const history = Array.from({ length: HISTORY }, (_, i) => shiftPeriodKey(g.period.key, i - HISTORY));

  const toggleOneOff = (key: string) => {
    const next = new Set(oneOff);
    if (!next.delete(key)) next.add(key);
    setOneOff(next);
  };

  const save = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const goalMinor = parseField(goal);
    if (goalMinor === undefined) {
      setMessage("Skriv sparmålet i kronor, till exempel 8 000.");
      return;
    }
    const overrides: { category_id: string; amount_minor: number }[] = [];
    for (const [categoryId, text] of levels) {
      const amountMinor = parseField(text);
      if (amountMinor === undefined) {
        setMessage("Skriv nivåerna i kronor, till exempel 2 500.");
        return;
      }
      if (amountMinor !== null) overrides.push({ category_id: categoryId, amount_minor: amountMinor });
    }
    setBusy(true);
    const { status } = await putJson("/api/guidelines", { mode, saving_goal_minor: goalMinor ?? 0, overrides, one_off_periods: [...oneOff].sort() });
    setBusy(false);
    if (status === 200) {
      setMessage(null);
      toast.done("Riktlinjerna är sparade.");
      props.onSaved();
    } else {
      setMessage("Det gick inte att spara riktlinjerna. Försök igen.");
    }
  };

  return (
    <>
      {saving && (
        <section className="card" aria-label="Kvar att spendera fritt">
          <dl className="stats">
            <div>
              <dt>Kvar att spendera fritt</dt>
              <dd>{formatSek(g.remainingMinor)}</dd>
            </div>
            <div>
              <dt>Per dag resten av perioden</dt>
              <dd>{formatSek(g.perDayMinor)}</dd>
            </div>
          </dl>
          {g.remainingMinor < 0 && <p role="note">Ni har spenderat {formatSek(-g.remainingMinor)} mer än det fria utrymmet.</p>}
          <small>
            Förväntad inkomst {formatSek(g.expectedIncomeMinor)} − fasta kostnader {formatSek(g.fixedMinor)} − sparmål {formatSek(g.savingGoalMinor)} = {formatSek(g.freeMinor)} att spendera fritt.
          </small>
          {!g.feasible && (
            <p role="alert">
              Sparmålet går inte ihop med inkomsten och de fasta kostnaderna. Det saknas {formatSek(g.shortfallMinor)} per period. Sänk sparmålet eller se över de fasta kostnaderna.
            </p>
          )}
          {g.expectedIncomeMinor === 0 && <p role="note">Ingen lön eller föräldrapenning hittades de senaste månaderna, så det fria utrymmet kan inte räknas.</p>}
        </section>
      )}

      <form className="card" aria-label="Riktlinjer" onSubmit={(e) => void save(e)}>
        <fieldset>
          <legend>Läge</legend>
          {MODES.map((m) => (
            <label key={m.mode} className="choice">
              <input type="radio" name="mode" checked={mode === m.mode} onChange={() => { setMode(m.mode); }} />
              {m.label}
              <small>{m.hint}</small>
            </label>
          ))}
        </fieldset>
        {mode === "saving" && (
          <label>
            Sparmål per period (kr)
            <input inputMode="decimal" placeholder="0" value={goal} onChange={(e) => { setGoal(e.target.value); }} />
          </label>
        )}

        <fieldset>
          <legend>Engångsperioder</legend>
          <small>Markera perioder som inte var normala, till exempel en renovering. De räknas inte i normalnivån, men väl i snittet.</small>
          {history.map((key) => (
            <label key={key} className="choice">
              <input type="checkbox" checked={oneOff.has(key)} onChange={() => { toggleOneOff(key); }} />
              {monthName(key)}
            </label>
          ))}
        </fieldset>

        {g.categories.length === 0 ? (
          <p>Det finns ingen historik att räkna riktlinjer på än.</p>
        ) : (
          <ul aria-label="Kategorier" className="guideline-list">
            {g.categories.map((c) => (
              <li key={c.categoryId} className={`budget-line${c.overPace ? " over" : ""}`}>
                <div className="tx-main">
                  <span className="tx-name">{nameOf(c.categoryId)}</span>
                  {c.overPace && <span className="budget-share">Över takt</span>}
                </div>
                <small>
                  Snitt {formatSek(c.averageMinor)} · normalt {formatSek(c.normalMinor)}
                  {c.fixedMinor > 0 && ` (varav fast ${formatSek(c.fixedMinor)})`}
                  {saving && ` · sparläge ${formatSek(c.savingMinor)}`}
                  {` · hittills ${formatSek(c.actualMinor)}`}
                </small>
                <label>
                  Egen nivå för {nameOf(c.categoryId)} (kr)
                  <input
                    inputMode="decimal"
                    placeholder="Beräknad"
                    value={levels.get(c.categoryId) ?? ""}
                    onChange={(e) => { setLevels(new Map(levels).set(c.categoryId, e.target.value)); }}
                  />
                </label>
              </li>
            ))}
          </ul>
        )}

        {message && <p role="alert">{message}</p>}
        <p className="actions">
          <button type="submit" className="primary" disabled={busy}>
            Spara
          </button>
        </p>
      </form>
    </>
  );
}

type State = { readonly kind: "loading" } | { readonly kind: "error" } | { readonly kind: "ready"; readonly guidelines: Guidelines };

export function GuidelinesView() {
  const [key, setKey] = useState("current");
  const [state, setState] = useState<State>({ kind: "loading" });
  const [categories, setCategories] = useState<Categories>(NO_CATEGORIES);
  const [accountIds, setAccountIds] = useState<string[]>([]);
  const [reload, setReload] = useState(0);
  const accounts = useAccountChoices();

  useEffect(() => {
    let current = true;
    void fetchCategories().then((loaded) => {
      if (current) setCategories(loaded);
    });
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    let current = true;
    setState({ kind: "loading" });
    void fetchGuidelines(key, accountIds).then((guidelines) => {
      if (current) setState(guidelines ? { kind: "ready", guidelines } : { kind: "error" });
    });
    return () => {
      current = false;
    };
  }, [key, reload, accountIds]);

  const guidelines = state.kind === "ready" ? state.guidelines : null;
  return (
    <main>
      <h1>Riktlinjer</h1>
      <p>
        <Link to="/budget">Till budget</Link>
      </p>
      <PeriodNav period={guidelines?.period ?? null} onGo={(months) => { if (guidelines) setKey(shiftPeriodKey(guidelines.period.key, months)); }} />
      <AccountFilter choices={accounts} selected={accountIds} onChange={setAccountIds} />
      {state.kind === "loading" && <p>Hämtar…</p>}
      {state.kind === "error" && <p role="alert">Det gick inte att hämta riktlinjerna. Försök igen om en stund.</p>}
      {guidelines && <GuidelinesForm key={`${guidelines.period.key}-${String(reload)}-${accountIds.join(",")}`} guidelines={guidelines} categories={categories} onSaved={() => { setReload((n) => n + 1); }} />}
      {guidelines && <ExportSection guidelines={guidelines} categories={categories} accountIds={accountIds} />}
    </main>
  );
}
