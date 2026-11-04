// Budget (#33, KK-20, KK-34): utfall mot plan per huvudkategori för en budgetperiod i taget. Utgifterna i
// underkategorierna summeras alltid uppåt, och underkategorierna visas när man fäller ut en rad. Varje
// rad visar budget, utfall, kvar och andel, och en överskriden budget syns med både färg och text
// (KK-20-B). Huvudkategorier med utgifter men utan budget visas också. Överföringar mellan egna konton
// räknas inte (KK-20-C). Budgeten sätts i BudgetEditor (KK-20-A) och tas bort i DeleteBudget (KK-40). Ett
// tryck på en kategori visar transaktionerna bakom utgifterna.
import { formatDateShort, formatSek } from "@kronkoll/domain";
import { useEffect, useState } from "react";
import { field, getJson } from "../api.ts";
import { Link } from "../router.tsx";
import { CategoryDot } from "../category-color.tsx";
import { useToast } from "../toast.tsx";
import { BudgetEditor } from "./BudgetEditor.tsx";
import { DeleteBudget } from "./DeleteBudget.tsx";
import { fetchCategories, NO_CATEGORIES, shiftPeriodKey, toPeriod, type Categories, type Period } from "../transactions/TransactionsView.tsx";

interface Figures {
  readonly categoryId: string;
  readonly budgetMinor: number | null;
  readonly actualMinor: number;
  readonly remainingMinor: number | null;
  readonly percent: number | null;
  readonly over: boolean;
}

interface Group extends Figures {
  readonly subcategories: readonly Figures[];
}

export interface Budget {
  readonly period: Period;
  /** Budgetraderna som de är sparade, för redigeringen. */
  readonly lines: readonly { readonly categoryId: string; readonly budgetMinor: number }[];
  readonly groups: readonly Group[];
  readonly uncategorizedMinor: number;
  readonly totalBudgetMinor: number;
  readonly totalActualMinor: number;
  readonly excludedInternalMinor: number;
}

const minor = (value: unknown) => (Number.isSafeInteger(value) ? (value as number) : 0);
const maybe = (value: unknown) => (Number.isSafeInteger(value) ? (value as number) : null);
const list = (value: unknown) => (Array.isArray(value) ? (value as unknown[]) : []);

function toFigures(raw: unknown): Figures | null {
  const categoryId = field(raw, "category_id");
  if (typeof categoryId !== "string") return null;
  return {
    categoryId,
    budgetMinor: maybe(field(raw, "budget_minor")),
    actualMinor: minor(field(raw, "actual_minor")),
    remainingMinor: maybe(field(raw, "remaining_minor")),
    percent: maybe(field(raw, "percent")),
    over: field(raw, "over") === true,
  };
}

export async function fetchBudget(key: string): Promise<Budget | null> {
  const { status, body } = await getJson(`/api/budgets/${encodeURIComponent(key)}`);
  const period = toPeriod(field(body, "period"));
  if (status !== 200 || !period || !Array.isArray(field(body, "groups"))) return null;
  return {
    period,
    lines: list(field(body, "lines")).flatMap((raw) => {
      const f = toFigures(raw);
      return f && f.budgetMinor !== null ? [{ categoryId: f.categoryId, budgetMinor: f.budgetMinor }] : [];
    }),
    groups: list(field(body, "groups")).flatMap((raw): Group[] => {
      const f = toFigures(raw);
      return f ? [{ ...f, subcategories: list(field(raw, "subcategories")).map(toFigures).filter((s): s is Figures => s !== null) }] : [];
    }),
    uncategorizedMinor: minor(field(body, "uncategorized_minor")),
    totalBudgetMinor: minor(field(body, "total_budget_minor")),
    totalActualMinor: minor(field(body, "total_actual_minor")),
    excludedInternalMinor: minor(field(body, "excluded_internal_minor")),
  };
}

/**
 * Andelen som text. Över budget står det alltid i ord, inte bara i färg (KK-20-B). En underkategori utan
 * egen budget ingår i huvudkategorins, så den får ingen märkning.
 */
function share(f: Figures, sub: boolean): string {
  if (f.budgetMinor === null) return sub ? "" : "Ingen budget";
  if (f.percent === null) return f.actualMinor > 0 ? "Över" : "–";
  return f.over ? `${String(f.percent)} % – över` : `${String(f.percent)} %`;
}

function details(f: Figures): string {
  if (f.budgetMinor === null || f.remainingMinor === null) return `${formatSek(f.actualMinor)} spenderat`;
  const left = f.over ? `över med ${formatSek(-f.remainingMinor)}` : `kvar ${formatSek(f.remainingMinor)}`;
  return `${formatSek(f.actualMinor)} av ${formatSek(f.budgetMinor)} · ${left}`;
}

/** Budgetens rader är huvudkategorier; de har ingen förälder att slå upp. */
const MAIN: ReadonlyMap<string, string | null> = new Map();

function BudgetRow(props: { figures: Figures; name: string; periodKey: string; sub?: boolean; toggle?: { open: boolean; count: number; onToggle: () => void } }) {
  const f = props.figures;
  const near = !f.over && f.percent !== null && f.percent >= 90;
  const tone = f.over ? " over" : near ? " near" : f.budgetMinor === null ? " none" : "";
  return (
    <li className={`budget-line${tone}${props.sub ? " sub" : ""}`}>
      <div className="tx-main">
        <span className="tx-name">
          {!props.sub && <CategoryDot categoryId={f.categoryId} parentOf={MAIN} />}
          {/* Raden leder till transaktionerna bakom utgifterna, med underkategorier och uppdelningar. */}
          <Link to={`/transaktioner?period=${encodeURIComponent(props.periodKey)}&kategori=${encodeURIComponent(f.categoryId)}`}>{props.name}</Link>
        </span>
        <span className="budget-share">{share(f, props.sub === true)}</span>
      </div>
      {f.budgetMinor !== null && (
        <progress className="budget-bar" aria-hidden="true" max={Math.max(f.budgetMinor, 1)} value={Math.min(f.actualMinor, f.budgetMinor)} />
      )}
      <small>{details(f)}</small>
      {props.toggle && (
        <p>
          <button type="button" className="small" aria-expanded={props.toggle.open} onClick={props.toggle.onToggle}>
            {props.toggle.open ? "Dölj underkategorier" : `Visa underkategorier (${String(props.toggle.count)})`}
          </button>
        </p>
      )}
    </li>
  );
}

type State = { readonly kind: "loading" } | { readonly kind: "error" } | { readonly kind: "ready"; readonly budget: Budget };

export function BudgetView() {
  const [key, setKey] = useState("current");
  const [state, setState] = useState<State>({ kind: "loading" });
  const [categories, setCategories] = useState<Categories>(NO_CATEGORIES);
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [reload, setReload] = useState(0);
  const toast = useToast();

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
  }, [key, reload]);

  const budget = state.kind === "ready" ? state.budget : null;
  const nameOf = (id: string) => categories.names.get(id) ?? id;
  // Underkategorier visas med bara sitt eget namn under huvudkategorin, t.ex. "Livsmedel".
  const shortName = (id: string) => nameOf(id).split(" › ").at(-1) ?? id;
  const go = (months: number) => {
    if (budget) setKey(shiftPeriodKey(budget.period.key, months));
    setEditing(false);
  };
  const toggle = (id: string) => {
    const next = new Set(open);
    if (!next.delete(id)) next.add(id);
    setOpen(next);
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
          {editing ? (
            <BudgetEditor
              periodKey={budget.period.key}
              lines={budget.lines}
              categories={categories}
              load={fetchBudget}
              onSaved={() => {
                setEditing(false);
                setReload((n) => n + 1);
              }}
              onClose={() => { setEditing(false); }}
            />
          ) : (
            <>
              <p>
                <button type="button" className="primary" onClick={() => { setEditing(true); }}>
                  {budget.lines.length === 0 ? "Sätt budget" : "Ändra budget"}
                </button>
              </p>
              {budget.lines.length > 0 && (
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
            </>
          )}
          {budget.lines.length === 0 && <p>Ingen budget är satt för perioden än.</p>}
          {budget.groups.length > 0 && (
            <ul aria-label="Kategorier">
              {budget.groups.flatMap((g) => [
                <BudgetRow
                  key={g.categoryId}
                  figures={g}
                  name={nameOf(g.categoryId)}
                  periodKey={budget.period.key}
                  {...(g.subcategories.length > 0
                    ? { toggle: { open: open.has(g.categoryId), count: g.subcategories.length, onToggle: () => { toggle(g.categoryId); } } }
                    : {})}
                />,
                ...(open.has(g.categoryId) ? g.subcategories.map((s) => <BudgetRow key={s.categoryId} figures={s} name={shortName(s.categoryId)} periodKey={budget.period.key} sub />) : []),
              ])}
            </ul>
          )}
          {budget.uncategorizedMinor > 0 && (
            <p>
              <Link to={`/transaktioner?period=${encodeURIComponent(budget.period.key)}&okategoriserade=1`}>Okategoriserade utgifter</Link>:{" "}
              {formatSek(budget.uncategorizedMinor)}
            </p>
          )}
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
