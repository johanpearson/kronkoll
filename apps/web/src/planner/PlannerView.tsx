// Planera budget (KK-42): ett arbetsblad som när man sätter upp en budget själv. Inkomsten skrivs som en eller
// flera rader (första raden är förifylld med förväntad inkomst). Per huvudkategori finns ett förslag, normalnivån
// ur historiken, som går att ändra. Summan av utgifterna och sparandet och vad som blir över räknas om medan man
// skriver, och ett underskott står i text. Planen sparas som periodens budget först när man väljer det, och
// utkastet ligger under tiden i webbläsaren (planner-draft.ts). Ersätter skärmen Riktlinjer och sparläge.
import { budgetPlan, formatSek } from "@kronkoll/domain";
import { useEffect, useState, type SyntheticEvent } from "react";
import { AccountFilter, useAccountChoices } from "../accounts/account-filter.tsx";
import { putJson } from "../api.ts";
import { parseField, toText } from "../budget/BudgetEditor.tsx";
import { fetchBudget } from "../budget/BudgetView.tsx";
import { fetchGuidelines, type Guidelines } from "../guidelines/guidelines.ts";
import { PeriodNav } from "../icon-button.tsx";
import { Link } from "../router.tsx";
import { useToast } from "../toast.tsx";
import { fetchCategories, NO_CATEGORIES, shiftPeriodKey, type Categories } from "../transactions/TransactionsView.tsx";
import { clearDraft, loadDraft, saveDraft, type Draft, type IncomeRow } from "./planner-draft.ts";

/** Hur många av de tidigare perioderna förslaget räknas på (samma som domänens NORMAL_MONTHS). */
const HISTORY = 6;

const MONTH = new Intl.DateTimeFormat("sv-SE", { month: "long", year: "numeric", timeZone: "UTC" });
const monthName = (key: string) => MONTH.format(new Date(`${key}-01T00:00:00Z`));

/** Fältets belopp i öre. Tomt är noll, och ett belopp som inte går att tolka räknas som noll men markeras. */
function amountOf(text: string): { readonly minor: number; readonly invalid: boolean } {
  const parsed = parseField(text);
  return { minor: parsed ?? 0, invalid: parsed === undefined };
}

function PlannerForm(props: { guidelines: Guidelines; categories: Categories; accountIds: readonly string[]; onChanged: () => void }) {
  const g = props.guidelines;
  const toast = useToast();
  const [draft, setDraft] = useState<Draft>(() => loadDraft(g.period.key));
  const [nextId, setNextId] = useState(1);
  const [confirm, setConfirm] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameOf = (id: string) => props.categories.names.get(id) ?? id;

  const defaultIncomes: readonly IncomeRow[] = [{ id: "forvantad", name: "Lön", text: g.expectedIncomeMinor > 0 ? toText(g.expectedIncomeMinor) : "" }];
  const incomes = draft.incomes ?? defaultIncomes;
  const rows = [...g.categories].sort((a, b) => nameOf(a.categoryId).localeCompare(nameOf(b.categoryId), "sv"));
  const textFor = (categoryId: string, normalMinor: number) => draft.edited[categoryId] ?? toText(normalMinor);

  const update = (next: Draft) => {
    setDraft(next);
    saveDraft(g.period.key, next);
    setConfirm(null);
  };

  const incomeAmounts = incomes.map((i) => amountOf(i.text));
  const rowAmounts = rows.map((c) => amountOf(textFor(c.categoryId, c.normalMinor)));
  const savingAmount = amountOf(draft.saving);
  const invalid = [...incomeAmounts, ...rowAmounts, savingAmount].some((a) => a.invalid);
  const plan = budgetPlan({
    incomesMinor: incomeAmounts.map((a) => a.minor),
    rows: rows.map((c, i) => ({ categoryId: c.categoryId, plannedMinor: rowAmounts[i]?.minor ?? 0 })),
    savingMinor: savingAmount.minor,
  });

  const setIncome = (id: string, change: Partial<IncomeRow>) => { update({ ...draft, incomes: incomes.map((i) => (i.id === id ? { ...i, ...change } : i)) }); };
  const addIncome = () => {
    setNextId(nextId + 1);
    update({ ...draft, incomes: [...incomes, { id: `ny-${String(nextId)}`, name: "", text: "" }] });
  };

  const reset = () => {
    clearDraft(g.period.key);
    setDraft({ incomes: null, edited: {}, saving: "" });
    setConfirm(null);
    setMessage(null);
  };

  const toggleOneOff = async (key: string) => {
    const next = new Set(g.oneOffPeriods);
    if (!next.delete(key)) next.add(key);
    setBusy(true);
    // Skärmen Riktlinjer och sparläge lagrar läge, sparmål och egna nivåer i samma anrop. De skickas tillbaka som de var.
    const { status } = await putJson("/api/guidelines", {
      mode: g.mode,
      saving_goal_minor: g.savingGoalMinor,
      overrides: g.categories.flatMap((c) => (c.overrideMinor === null ? [] : [{ category_id: c.categoryId, amount_minor: c.overrideMinor }])),
      one_off_periods: [...next].sort(),
    });
    setBusy(false);
    if (status === 200) props.onChanged();
    else setMessage("Det gick inte att spara engångsperioden. Försök igen.");
  };

  const write = async () => {
    setBusy(true);
    const lines = rows.flatMap((c, i) => ((rowAmounts[i]?.minor ?? 0) > 0 ? [{ category_id: c.categoryId, amount_minor: rowAmounts[i]?.minor ?? 0 }] : []));
    const { status } = await putJson(`/api/budgets/${encodeURIComponent(g.period.key)}`, { lines, source: "manual" });
    setBusy(false);
    if (status === 200) {
      clearDraft(g.period.key);
      toast.done("Budgeten för perioden är sparad.");
      props.onChanged();
    } else {
      setMessage("Det gick inte att spara budgeten. Försök igen.");
    }
  };

  /** Finns det redan en budget för perioden frågar vi först, eftersom den ersätts. */
  const saveAsBudget = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (invalid) {
      setMessage("Skriv beloppen i kronor, till exempel 6 300.");
      return;
    }
    setMessage(null);
    setBusy(true);
    const existing = await fetchBudget(g.period.key, props.accountIds);
    setBusy(false);
    if (!existing) {
      setMessage("Det gick inte att kontrollera periodens budget. Försök igen.");
      return;
    }
    if (existing.lines.length > 0) setConfirm(existing.lines.length);
    else await write();
  };

  const history = Array.from({ length: HISTORY }, (_, i) => shiftPeriodKey(g.period.key, i - HISTORY));

  return (
    <form className="card planner" aria-label="Planera budget" onSubmit={(e) => void saveAsBudget(e)}>
      <h2>Inkomst</h2>
      {incomes.length === 0 && <p>Lägg till en inkomst för att se vad som blir över.</p>}
      {incomes.map((i) => (
        <div key={i.id} className="income-row">
          <input aria-label="Namn på inkomsten" placeholder="Namn" value={i.name} onChange={(e) => { setIncome(i.id, { name: e.target.value }); }} />
          <input aria-label={`Belopp för ${i.name === "" ? "inkomsten" : i.name} (kr)`} inputMode="decimal" placeholder="0" value={i.text} onChange={(e) => { setIncome(i.id, { text: e.target.value }); }} />
          <button type="button" className="small" aria-label={`Ta bort ${i.name === "" ? "inkomsten" : i.name}`} onClick={() => { update({ ...draft, incomes: incomes.filter((x) => x.id !== i.id) }); }}>
            Ta bort
          </button>
        </div>
      ))}
      <p>
        <button type="button" className="small" onClick={addIncome}>
          Lägg till inkomst
        </button>
      </p>
      {draft.incomes === null && g.expectedIncomeMinor > 0 && <small>Förifylld med förväntad inkomst: medianen av lön och föräldrapenning de tre senaste månaderna.</small>}

      <h2>Utgifter</h2>
      {rows.length === 0 ? (
        <p>Det finns ingen historik att ta förslag ur än. Lägg till beloppen när du har några transaktioner.</p>
      ) : (
        <ul aria-label="Utgifter" className="guideline-list">
          {rows.map((c, i) => (
            <li key={c.categoryId} className="budget-line">
              <div className="tx-main">
                <span className="tx-name">{nameOf(c.categoryId)}</span>
                {c.fixedMinor > 0 && <span className="budget-share">Fast</span>}
              </div>
              <small>
                Förra perioden {formatSek(c.lastMinor)}
                {c.fixedMinor > 0 && ` · varav fast ${formatSek(c.fixedMinor)}`}
                {plan.rows[i]?.shareOfIncomePercent !== null && ` · ${String(plan.rows[i]?.shareOfIncomePercent)} % av inkomsten`}
              </small>
              <input
                className="level-input"
                inputMode="decimal"
                aria-label={`Utgift för ${nameOf(c.categoryId)} (kr)`}
                aria-invalid={rowAmounts[i]?.invalid === true}
                value={textFor(c.categoryId, c.normalMinor)}
                onChange={(e) => { update({ ...draft, edited: { ...draft.edited, [c.categoryId]: e.target.value } }); }}
              />
            </li>
          ))}
        </ul>
      )}

      <label>
        Sparande per månad (valfritt)
        <input inputMode="decimal" placeholder="0" aria-invalid={savingAmount.invalid} value={draft.saving} onChange={(e) => { update({ ...draft, saving: e.target.value }); }} />
      </label>

      <section aria-label="Summering" className="plan-summary">
        <dl className="stats">
          <div>
            <dt>Inkomst</dt>
            <dd>{formatSek(plan.incomeMinor)}</dd>
          </div>
          <div>
            <dt>Utgifter</dt>
            <dd>{formatSek(plan.expensesMinor)}</dd>
          </div>
          <div>
            <dt>Sparande</dt>
            <dd>{formatSek(plan.savingMinor)}</dd>
          </div>
          <div className={plan.deficit ? "deficit" : ""}>
            <dt>{plan.deficit ? "Underskott" : "Blir över"}</dt>
            <dd>{formatSek(Math.abs(plan.leftoverMinor))}</dd>
          </div>
        </dl>
        {plan.deficit && (
          <p role="note">
            Utgifterna och sparandet är {formatSek(-plan.leftoverMinor)} mer än inkomsten.
          </p>
        )}
      </section>

      <fieldset className="choices months">
        <legend>Engångsperioder</legend>
        <small>Markera perioder som inte var normala, till exempel en renovering. De räknas inte i förslagen.</small>
        {history.map((key) => (
          <label key={key}>
            <input type="checkbox" disabled={busy} checked={g.oneOffPeriods.includes(key)} onChange={() => void toggleOneOff(key)} />
            {monthName(key)}
          </label>
        ))}
      </fieldset>

      {confirm !== null && (
        <section className="card" role="region" aria-label="Ersätt budgeten">
          <p>Perioden har redan en budget med {String(confirm)} kategorier. Den ersätts av planen. Utfallet och transaktionerna ändras inte.</p>
          <p className="actions">
            <button type="button" className="primary" disabled={busy} onClick={() => void write()}>
              Ersätt budgeten
            </button>
            <button type="button" onClick={() => { setConfirm(null); }}>
              Avbryt
            </button>
          </p>
        </section>
      )}

      {message && <p role="alert">{message}</p>}
      <p className="actions">
        <button type="submit" className="primary" disabled={busy}>
          Spara som budget för perioden
        </button>
        <button type="button" onClick={reset}>
          Återställ förslaget
        </button>
      </p>
    </form>
  );
}

type State = { readonly kind: "loading" } | { readonly kind: "error" } | { readonly kind: "ready"; readonly guidelines: Guidelines };

export function PlannerView() {
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
      <h1>Planera budget</h1>
      <p>
        <Link to="/budget">Till budget</Link>
      </p>
      <PeriodNav period={guidelines?.period ?? null} onGo={(months) => { if (guidelines) setKey(shiftPeriodKey(guidelines.period.key, months)); }} />
      <AccountFilter choices={accounts} selected={accountIds} onChange={setAccountIds} />
      {state.kind === "loading" && <p>Hämtar…</p>}
      {state.kind === "error" && <p role="alert">Det gick inte att hämta underlaget till planen. Försök igen om en stund.</p>}
      {guidelines && (
        <PlannerForm key={`${guidelines.period.key}-${String(reload)}-${accountIds.join(",")}`} guidelines={guidelines} categories={categories} accountIds={accountIds} onChanged={() => { setReload((n) => n + 1); }} />
      )}
    </main>
  );
}
