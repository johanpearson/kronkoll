// Budget (#33, KK-20, KK-34): utfall mot plan per kategori för en budgetperiod i taget. Varje rad
// visar budget, utfall, kvar och andel, och en överskriden budget syns med både färg och text
// (KK-20-B). Överföringar mellan egna konton räknas inte, och vyn säger hur mycket det gällde
// (KK-20-C). Att sätta budget och förslag (KK-20-A) kommer i nästa steg.
import { formatDateShort, formatSek } from "@kronkoll/domain";
import { useEffect, useState } from "react";
import { field, getJson } from "../api.ts";
import { fetchCategories, NO_CATEGORIES, shiftPeriodKey, toPeriod, type Categories, type Period } from "../transactions/TransactionsView.tsx";

interface Line {
  readonly categoryId: string;
  readonly budgetMinor: number;
  readonly actualMinor: number;
  readonly remainingMinor: number;
  readonly percent: number | null;
  readonly over: boolean;
}

interface Budget {
  readonly period: Period;
  readonly lines: readonly Line[];
  readonly unbudgetedMinor: number;
  readonly totalBudgetMinor: number;
  readonly totalActualMinor: number;
  readonly excludedInternalMinor: number;
}

const minor = (value: unknown) => (Number.isSafeInteger(value) ? (value as number) : 0);

/** En rad ur API:ts svar, eller null om den inte ser ut som en budgetrad. */
function toLine(raw: unknown): Line | null {
  const categoryId = field(raw, "category_id");
  if (typeof categoryId !== "string") return null;
  const percent = field(raw, "percent");
  return {
    categoryId,
    budgetMinor: minor(field(raw, "budget_minor")),
    actualMinor: minor(field(raw, "actual_minor")),
    remainingMinor: minor(field(raw, "remaining_minor")),
    percent: typeof percent === "number" ? percent : null,
    over: field(raw, "over") === true,
  };
}

async function fetchBudget(key: string): Promise<Budget | null> {
  const { status, body } = await getJson(`/api/budgets/${encodeURIComponent(key)}`);
  const period = toPeriod(field(body, "period"));
  const lines = field(body, "lines");
  if (status !== 200 || !period || !Array.isArray(lines)) return null;
  return {
    period,
    lines: lines.map(toLine).filter((l): l is Line => l !== null),
    unbudgetedMinor: minor(field(body, "unbudgeted_minor")),
    totalBudgetMinor: minor(field(body, "total_budget_minor")),
    totalActualMinor: minor(field(body, "total_actual_minor")),
    excludedInternalMinor: minor(field(body, "excluded_internal_minor")),
  };
}

/** Andelen som text. Över budget står det alltid i ord, inte bara i färg (KK-20-B). */
function share(line: Line): string {
  if (line.percent === null) return line.actualMinor > 0 ? "Över" : "–";
  return line.over ? `${String(line.percent)} % – över` : `${String(line.percent)} %`;
}

function BudgetLine({ line, name }: { line: Line; name: string }) {
  const near = !line.over && line.percent !== null && line.percent >= 90;
  const left = line.over ? `över med ${formatSek(-line.remainingMinor)}` : `kvar ${formatSek(line.remainingMinor)}`;
  return (
    <li className={line.over ? "budget-line over" : near ? "budget-line near" : "budget-line"}>
      <div className="tx-main">
        <span className="tx-name">{name}</span>
        <span className="budget-share">{share(line)}</span>
      </div>
      <progress className="budget-bar" aria-hidden="true" max={Math.max(line.budgetMinor, 1)} value={Math.min(line.actualMinor, line.budgetMinor)} />
      <small>
        {formatSek(line.actualMinor)} av {formatSek(line.budgetMinor)} · {left}
      </small>
    </li>
  );
}

type State = { readonly kind: "loading" } | { readonly kind: "error" } | { readonly kind: "ready"; readonly budget: Budget };

export function BudgetView() {
  const [key, setKey] = useState("current");
  const [state, setState] = useState<State>({ kind: "loading" });
  const [categories, setCategories] = useState<Categories>(NO_CATEGORIES);

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
    void fetchBudget(key).then((budget) => {
      if (current) setState(budget ? { kind: "ready", budget } : { kind: "error" });
    });
    return () => {
      current = false;
    };
  }, [key]);

  const budget = state.kind === "ready" ? state.budget : null;
  const nameOf = (id: string) => categories.names.get(id) ?? id;
  const go = (months: number) => {
    if (budget) setKey(shiftPeriodKey(budget.period.key, months));
  };

  return (
    <main>
      <h1>Budget</h1>
      <p>
        <button type="button" disabled={!budget} onClick={() => { go(-1); }}>
          Föregående period
        </button>{" "}
        <button type="button" disabled={!budget} onClick={() => { go(1); }}>
          Nästa period
        </button>
      </p>
      {state.kind === "loading" && <p>Hämtar…</p>}
      {state.kind === "error" && <p role="alert">Det gick inte att hämta budgeten. Försök igen om en stund.</p>}
      {budget && (
        <>
          <p>
            Period {formatDateShort(budget.period.start)} – {formatDateShort(budget.period.end)}
          </p>
          <dl className="card stats">
            <div>
              <dt>Budget</dt>
              <dd>{formatSek(budget.totalBudgetMinor)}</dd>
            </div>
            <div>
              <dt>Utfall</dt>
              <dd>{formatSek(budget.totalActualMinor)}</dd>
            </div>
            <div>
              <dt>Kvar</dt>
              <dd>{formatSek(budget.totalBudgetMinor - budget.totalActualMinor)}</dd>
            </div>
          </dl>
          {budget.lines.length === 0 ? (
            <p>Ingen budget är satt för perioden än.</p>
          ) : (
            <ul aria-label="Kategorier">
              {[...budget.lines]
                .sort((a, b) => nameOf(a.categoryId).localeCompare(nameOf(b.categoryId), "sv"))
                .map((line) => (
                  <BudgetLine key={line.categoryId} line={line} name={nameOf(line.categoryId)} />
                ))}
            </ul>
          )}
          {budget.unbudgetedMinor > 0 && <p>Utgifter utan budget: {formatSek(budget.unbudgetedMinor)}</p>}
          {budget.excludedInternalMinor > 0 && (
            <p className="note" role="note">
              Överföringar mellan dina egna konton och kortfakturor ({formatSek(budget.excludedInternalMinor)}) räknas inte som utgifter.
            </p>
          )}
        </>
      )}
    </main>
  );
}
