// Budget (KK-42, KK-45): ett arbetsblad som när man sätter upp en budget själv. Inkomsten skrivs som en eller
// flera rader (första raden är förifylld med förväntad inkomst). Per huvudkategori finns ett förslag, normalnivån
// ur historiken, som går att ändra. Summan av utgifterna och sparandet och vad som blir över räknas om medan man
// skriver, och ett underskott står i text. Planen sparas som periodens budget först när man väljer det, och
// utkastet ligger under tiden i webbläsaren (planner-draft.ts). Ersätter Riktlinjer, sparläge och den gamla Budgetvyn.
import { budgetPlan, formatSek, planProgress } from "@kronkoll/domain";
import { useEffect, useState, type SyntheticEvent } from "react";
import { AccountFilter, useAccountChoices } from "../accounts/account-filter.tsx";
import { putJson } from "../api.ts";
import { parseField, toText } from "../kronor.ts";
import { fetchBudget, type Budget } from "../budget/budget-data.ts";
import { DeleteBudget } from "../budget/DeleteBudget.tsx";
import { fetchGuidelines, type GuidelineCategory, type Guidelines } from "../guidelines/guidelines.ts";
import { PeriodNav } from "../icon-button.tsx";
import { Link } from "../router.tsx";
import { CategoryDot } from "../category-color.tsx";
import { useToast } from "../toast.tsx";
import { fetchCategories, NO_CATEGORIES, shiftPeriodKey, type Categories } from "../transactions/TransactionsView.tsx";
import { ExportSection } from "./ExportSection.tsx";
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

/** Huvudkategorier har ingen förälder att slå upp. */
const MAIN: ReadonlyMap<string, string | null> = new Map();

function PlannerForm(props: { guidelines: Guidelines; budget: Budget | null; categories: Categories; accountIds: readonly string[]; onChanged: () => void }) {
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
  // Ett belopp som redan är sparat som periodens budget är utgångsläget, annars normalnivån. En kategori som har
  // budget men ingen historik tas med, så att den inte försvinner när planen sparas.
  const saved = new Map((props.budget?.groups ?? []).flatMap((b) => (b.budgetMinor === null ? [] : [[b.categoryId, b] as const])));
  const known = new Set(g.categories.map((c) => c.categoryId));
  const extra: GuidelineCategory[] = [...saved.values()]
    .filter((b) => !known.has(b.categoryId))
    .map((b) => ({ categoryId: b.categoryId, averageMinor: 0, normalMinor: 0, fixedMinor: 0, actualMinor: b.actualMinor, lastMinor: 0 }));
  const rows = [...g.categories, ...extra].sort((a, b) => nameOf(a.categoryId).localeCompare(nameOf(b.categoryId), "sv"));
  const textFor = (categoryId: string, normalMinor: number) => draft.edited[categoryId] ?? toText(saved.get(categoryId)?.budgetMinor ?? normalMinor);

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
    const { status } = await putJson("/api/guidelines", { one_off_periods: [...next].sort() });
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
          {rows.map((c, i) => {
            const progress = planProgress(rowAmounts[i]?.minor ?? 0, c.actualMinor);
            const planned = rowAmounts[i]?.minor ?? 0;
            const near = !progress.over && progress.percent !== null && progress.percent >= 90;
            return (
            <li key={c.categoryId} className={`budget-line${progress.over ? " over" : near ? " near" : ""}`}>
              <div className="tx-main">
                <span className="tx-name">
                  <CategoryDot categoryId={c.categoryId} parentOf={MAIN} />
                  {/* Raden leder till transaktionerna bakom utfallet, med underkategorier och uppdelningar. */}
                  <Link to={`/transaktioner?period=${encodeURIComponent(g.period.key)}&kategori=${encodeURIComponent(c.categoryId)}`}>{nameOf(c.categoryId)}</Link>
                </span>
                {c.fixedMinor > 0 && <span className="budget-share">Fast</span>}
              </div>
              {planned > 0 && <progress className="budget-bar" aria-hidden="true" max={planned} value={Math.min(c.actualMinor, planned)} />}
              <small className="budget-actual">
                {`Utfall ${formatSek(c.actualMinor)}`}
                {planned > 0 && ` · ${progress.over ? `över med ${formatSek(-progress.remainingMinor)}` : `kvar ${formatSek(progress.remainingMinor)}`}`}
                {progress.percent !== null && ` · ${String(progress.percent)} %${progress.over ? " – över" : ""}`}
                {planned === 0 && c.actualMinor > 0 && " · ingen budget"}
              </small>
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
            );
          })}
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

type State = { readonly kind: "loading" } | { readonly kind: "error" } | { readonly kind: "ready"; readonly guidelines: Guidelines; readonly budget: Budget | null };

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
    // Periodens sparade budget är utgångsläget för beloppen. Går den inte att hämta fungerar planeringen ändå.
    void Promise.all([fetchGuidelines(key, accountIds), fetchBudget(key, accountIds)]).then(([guidelines, budget]) => {
      if (current) setState(guidelines ? { kind: "ready", guidelines, budget } : { kind: "error" });
    });
    return () => {
      current = false;
    };
  }, [key, reload, accountIds]);

  const guidelines = state.kind === "ready" ? state.guidelines : null;
  const budget = state.kind === "ready" ? state.budget : null;
  const toast = useToast();
  return (
    <main>
      <h1>Budget</h1>
      <PeriodNav period={guidelines?.period ?? null} onGo={(months) => { if (guidelines) setKey(shiftPeriodKey(guidelines.period.key, months)); }} />
      <AccountFilter choices={accounts} selected={accountIds} onChange={setAccountIds} />
      {state.kind === "loading" && <p>Hämtar…</p>}
      {state.kind === "error" && <p role="alert">Det gick inte att hämta underlaget till planen. Försök igen om en stund.</p>}
      {guidelines && (
        <PlannerForm key={`${guidelines.period.key}-${String(reload)}-${accountIds.join(",")}`} guidelines={guidelines} budget={budget} categories={categories} accountIds={accountIds} onChanged={() => { setReload((n) => n + 1); }} />
      )}
      {guidelines && budget && budget.lines.length > 0 && (
        <DeleteBudget
          key={budget.period.key}
          periodKey={budget.period.key}
          lineCount={budget.lines.length}
          onDeleted={() => {
            toast.done("Budgeten för perioden är borttagen.");
            setReload((n) => n + 1);
          }}
        />
      )}
      {guidelines && budget && budget.uncategorizedMinor > 0 && (
        <p>
          <Link to={`/transaktioner?period=${encodeURIComponent(budget.period.key)}&okategoriserade=1`}>Okategoriserade utgifter</Link>: {formatSek(budget.uncategorizedMinor)}
        </p>
      )}
      {guidelines && budget && budget.excludedInternalMinor > 0 && (
        <p className="note" role="note">
          Överföringar mellan dina egna konton och kortfakturor ({formatSek(budget.excludedInternalMinor)}) räknas inte som utgifter.
        </p>
      )}
      {guidelines && <ExportSection guidelines={guidelines} categories={categories} accountIds={accountIds} />}
    </main>
  );
}
