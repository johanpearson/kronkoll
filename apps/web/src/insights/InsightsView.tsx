// Insikter (#41, KK-24): avvikelser mot snittet, återkommande dragningar, periodens största utgifter och
// utgifter per huvudkategori. Allt räknas i API:t (GET /api/insights). Namnen kommer från banken och
// visas alltid som text (KK-30).
import { formatDateShort, formatSek } from "@kronkoll/domain";
import { useEffect, useState } from "react";
import { field, getJson } from "../api.ts";
import { CategoryDot } from "../category-color.tsx";
import { PeriodNav } from "../icon-button.tsx";
import { Link } from "../router.tsx";
import { fetchCategories, NO_CATEGORIES, shiftPeriodKey, toPeriod, type Categories, type Period } from "../transactions/TransactionsView.tsx";

interface Anomaly { readonly categoryId: string; readonly actualMinor: number; readonly baselineMinor: number; readonly diffMinor: number; readonly pct: number | null }
interface Recurring { readonly name: string; readonly yearly: boolean; readonly amountMinor: number; readonly nextExpected: string; readonly yearlyMinor: number }
interface Expense { readonly id: string; readonly name: string; readonly amountMinor: number; readonly categoryId: string | null; readonly split: boolean }
interface CategorySpend { readonly categoryId: string | null; readonly amountMinor: number }
export interface Insights {
  readonly period: Period;
  readonly anomalies: readonly Anomaly[];
  readonly recurring: readonly Recurring[];
  readonly recurringYearlyMinor: number;
  readonly topExpenses: readonly Expense[];
  readonly topCategories: readonly CategorySpend[];
}

const int = (v: unknown) => (Number.isSafeInteger(v) ? (v as number) : 0);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const optional = (v: unknown) => (typeof v === "string" ? v : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function toInsights(body: unknown): Insights | null {
  const period = toPeriod(field(body, "period"));
  if (!period) return null;
  return {
    period,
    anomalies: list(field(body, "anomalies")).map((a) => ({
      categoryId: str(field(a, "category_id")),
      actualMinor: int(field(a, "actual_minor")),
      baselineMinor: int(field(a, "baseline_minor")),
      diffMinor: int(field(a, "diff_minor")),
      pct: Number.isSafeInteger(field(a, "pct")) ? (field(a, "pct") as number) : null,
    })),
    recurring: list(field(body, "recurring")).map((r) => ({
      name: str(field(r, "name")),
      yearly: field(r, "interval") === "yearly",
      amountMinor: int(field(r, "amount_minor")),
      nextExpected: str(field(r, "next_expected")),
      yearlyMinor: int(field(r, "yearly_minor")),
    })),
    recurringYearlyMinor: int(field(body, "recurring_yearly_minor")),
    topExpenses: list(field(body, "top_expenses")).map((e) => ({
      id: str(field(e, "id")),
      name: str(field(e, "name")),
      amountMinor: int(field(e, "amount_minor")),
      categoryId: optional(field(e, "category_id")),
      split: field(e, "split") === true,
    })),
    topCategories: list(field(body, "top_categories")).map((c) => ({ categoryId: optional(field(c, "category_id")), amountMinor: int(field(c, "amount_minor")) })),
  };
}

async function fetchInsights(key: string): Promise<Insights | null> {
  const { status, body } = await getJson(key === "current" ? "/api/insights" : `/api/insights?period=${encodeURIComponent(key)}`);
  return status === 200 ? toInsights(body) : null;
}

const TOP = 5;

function Sections(props: { insights: Insights; categories: Categories }) {
  const { insights: i, categories } = props;
  const [all, setAll] = useState(false);
  const nameOf = (id: string | null) => (id === null ? "Okategoriserat" : (categories.names.get(id) ?? id));
  const dot = (id: string | null) => id !== null && <CategoryDot categoryId={id} parentOf={categories.parentOf} />;
  return (
    <>
      <section className="card">
        <h2>Avvikelser mot snittet</h2>
        {i.anomalies.length === 0 ? (
          <p>Ingen kategori ligger mer än 30 % och 500 kr över snittet för de tre föregående perioderna.</p>
        ) : (
          <ul aria-label="Avvikelser">
            {i.anomalies.map((a) => (
              <li key={a.categoryId} className="tx">
                <div className="tx-main">
                  <span className="tx-name">
                    {dot(a.categoryId)} {nameOf(a.categoryId)}
                  </span>
                  <span className="badge warn">{a.pct === null ? `Ny, +${formatSek(a.diffMinor)}` : `+${String(a.pct)} %, +${formatSek(a.diffMinor)}`}</span>
                </div>
                <small className="tx-notes">
                  {formatSek(a.actualMinor)} mot snitt {formatSek(a.baselineMinor)}
                </small>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="card">
        <h2>Återkommande dragningar</h2>
        {i.recurring.length === 0 ? (
          <p>Inga återkommande dragningar hittade. Det behövs tre dragningar i månaden eller två om året.</p>
        ) : (
          <>
            <p>Ungefär {formatSek(i.recurringYearlyMinor)} per år.</p>
            <ul aria-label="Återkommande dragningar">
              {i.recurring.map((r) => (
                <li key={r.name} className="tx">
                  <div className="tx-main">
                    <span className="tx-name">{r.name}</span>
                    <span className="amount">
                      {formatSek(r.amountMinor)}/{r.yearly ? "år" : "mån"}
                    </span>
                  </div>
                  <small className="tx-notes">
                    {r.yearly ? "Årsvis" : `Månadsvis, ${formatSek(r.yearlyMinor)}/år`} · nästa ≈ {formatDateShort(r.nextExpected)}
                  </small>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
      <section className="card">
        <h2>Största utgifter</h2>
        {i.topExpenses.length === 0 ? (
          <p>Inga utgifter i perioden.</p>
        ) : (
          <ul aria-label="Största utgifter">
            {i.topExpenses.map((e) => (
              <li key={e.id} className="tx">
                <div className="tx-main">
                  <Link to={`/transaktioner/${encodeURIComponent(e.id)}`}>{e.name === "" ? "Okänd mottagare" : e.name}</Link>
                  <span className="amount">{formatSek(e.amountMinor)}</span>
                </div>
                <small className="tx-notes">{e.split ? `Uppdelad, mest ${nameOf(e.categoryId)}` : nameOf(e.categoryId)}</small>
              </li>
            ))}
          </ul>
        )}
      </section>
      {i.topCategories.length > 0 && (
        <section className="card">
          <h2>Utgifter per kategori</h2>
          <ul aria-label="Utgifter per kategori">
            {(all ? i.topCategories : i.topCategories.slice(0, TOP)).map((c) => (
              <li key={c.categoryId ?? ""} className="tx">
                <div className="tx-main">
                  <span className="tx-name">
                    {dot(c.categoryId)} {nameOf(c.categoryId)}
                  </span>
                  <span className="amount">{formatSek(c.amountMinor)}</span>
                </div>
              </li>
            ))}
          </ul>
          {i.topCategories.length > TOP && (
            <button type="button" onClick={() => { setAll(!all); }}>
              {all ? "Visa de fem största" : `Visa alla ${String(i.topCategories.length)}`}
            </button>
          )}
        </section>
      )}
    </>
  );
}

type State = { readonly kind: "loading" } | { readonly kind: "error" } | { readonly kind: "ready"; readonly insights: Insights };

export function InsightsView() {
  const [key, setKey] = useState("current");
  const [state, setState] = useState<State>({ kind: "loading" });
  const [categories, setCategories] = useState<Categories>(NO_CATEGORIES);

  useEffect(() => {
    void fetchCategories().then(setCategories);
  }, []);

  useEffect(() => {
    let current = true;
    setState({ kind: "loading" });
    void fetchInsights(key).then((insights) => {
      if (current) setState(insights ? { kind: "ready", insights } : { kind: "error" });
    });
    return () => {
      current = false;
    };
  }, [key]);

  const insights = state.kind === "ready" ? state.insights : null;
  const go = (months: number) => {
    if (insights) setKey(shiftPeriodKey(insights.period.key, months));
  };
  return (
    <main>
      <p>
        <Link to="/">‹ Översikt</Link>
      </p>
      <h1>Insikter</h1>
      <PeriodNav period={insights?.period ?? null} onGo={go} />
      {state.kind === "loading" && <p>Hämtar…</p>}
      {state.kind === "error" && <p role="alert">Det gick inte att hämta insikterna. Försök igen om en stund.</p>}
      {insights && <Sections key={insights.period.key} insights={insights} categories={categories} />}
    </main>
  );
}
