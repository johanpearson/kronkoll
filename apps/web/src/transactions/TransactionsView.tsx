// Transaktionslistan (#32, KK-4, KK-9, KK-30): en budgetperiod i taget, grupperad per dag, nyast
// först. Bankens text renderas alltid som text, aldrig som HTML. Kategorin visas med namn, t.ex.
// "Mat › Livsmedel". Kategorin kan bytas och transaktionen delas upp direkt i listan.
import { formatDateShort, formatSek } from "@kronkoll/domain";
import { useCallback, useEffect, useState, type SyntheticEvent } from "react";
import { field, getJson } from "../api.ts";
import { CategoryEditor, type CategoryOption } from "./CategoryEditor.tsx";
import { SplitEditor } from "./SplitEditor.tsx";

interface Transaction {
  readonly id: string;
  readonly status: string;
  readonly transactionDate: string;
  readonly amountMinor: number;
  readonly counterparty: string;
  readonly description: string;
  readonly categoryId: string | null;
  readonly isInternalTransfer: boolean;
  readonly split: boolean;
}

interface Period {
  readonly key: string;
  readonly start: string;
  readonly end: string;
}

/** Periodnyckeln (ÅÅÅÅ-MM) flyttad ett antal månader. */
export function shiftPeriodKey(key: string, months: number): string {
  const [year, month] = key.split("-").map(Number);
  const index = (year ?? 0) * 12 + (month ?? 1) - 1 + months;
  return `${String(Math.floor(index / 12))}-${String((index % 12) + 1).padStart(2, "0")}`;
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** En rad ur API:ts svar, eller null om den inte ser ut som en transaktion. */
function toTransaction(raw: unknown): Transaction | null {
  const id = field(raw, "id");
  const date = field(raw, "transaction_date");
  const amount = field(raw, "amount_minor");
  if (typeof id !== "string" || typeof date !== "string" || typeof amount !== "number") return null;
  const category = field(raw, "category_id");
  return {
    id,
    status: text(field(raw, "status")),
    transactionDate: date,
    amountMinor: amount,
    counterparty: text(field(raw, "counterparty")),
    description: text(field(raw, "description")),
    categoryId: typeof category === "string" ? category : null,
    isInternalTransfer: field(raw, "is_internal_transfer") === true,
    split: field(raw, "split") === true,
  };
}

function toPeriod(raw: unknown): Period | null {
  const key = field(raw, "key");
  const start = field(raw, "start");
  const end = field(raw, "end");
  return typeof key === "string" && typeof start === "string" && typeof end === "string" ? { key, start, end } : null;
}

type Filters = { readonly period: string | null; readonly q: string; readonly uncategorized: boolean };

type ListState =
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | { readonly kind: "ready"; readonly period: Period; readonly items: readonly Transaction[]; readonly nextCursor: string | null; readonly loadingMore: boolean };

function url(filters: Filters, cursor: string | null): string {
  const params = new URLSearchParams();
  if (filters.period) params.set("period", filters.period);
  if (filters.q.trim() !== "") params.set("q", filters.q.trim());
  if (filters.uncategorized) params.set("uncategorized", "true");
  if (cursor) params.set("cursor", cursor);
  const query = params.toString();
  return query === "" ? "/api/transactions" : `/api/transactions?${query}`;
}

async function fetchPage(filters: Filters, cursor: string | null) {
  const { status, body } = await getJson(url(filters, cursor));
  const period = toPeriod(field(body, "period"));
  const rawItems = field(body, "items");
  if (status !== 200 || !period || !Array.isArray(rawItems)) return null;
  const items = rawItems.map(toTransaction).filter((t): t is Transaction => t !== null);
  const next = field(body, "next_cursor");
  return { period, items, nextCursor: typeof next === "string" ? next : null };
}

function groupByDay(items: readonly Transaction[]): [string, Transaction[]][] {
  const days = new Map<string, Transaction[]>();
  for (const item of items) days.set(item.transactionDate, [...(days.get(item.transactionDate) ?? []), item]);
  return [...days];
}

interface Categories {
  /** Namn per id, t.ex. "Mat › Livsmedel", även för arkiverade. */
  readonly names: ReadonlyMap<string, string>;
  /** Det som går att välja: inte arkiverade, sorterade efter namn. */
  readonly options: readonly CategoryOption[];
}

/** Kategorierna, eller inga om de inte går att hämta. Listan fungerar ändå. */
async function fetchCategories(): Promise<Categories> {
  const { status, body } = await getJson("/api/categories");
  const items = field(body, "items");
  if (status !== 200 || !Array.isArray(items)) return { names: new Map(), options: [] };
  const raw = new Map<string, { name: string; parent: string | null; archived: boolean }>();
  for (const item of items) {
    const id = field(item, "id");
    const name = field(item, "name");
    const parent = field(item, "parent_id");
    if (typeof id === "string" && typeof name === "string") {
      raw.set(id, { name, parent: typeof parent === "string" ? parent : null, archived: field(item, "archived") === true });
    }
  }
  const names = new Map(
    [...raw].map(([id, { name, parent }]) => {
      const parentName = parent === null ? undefined : raw.get(parent)?.name;
      return [id, parentName === undefined ? name : `${parentName} › ${name}`];
    }),
  );
  const options = [...raw]
    .filter(([, c]) => !c.archived)
    .map(([id]) => ({ id, label: names.get(id) ?? id }))
    .sort((a, b) => a.label.localeCompare(b.label, "sv"));
  return { names, options };
}

function Row(props: {
  transaction: Transaction;
  categories: Categories;
  /** Vad som är öppet på raden just nu, om något. */
  mode: "category" | "split" | null;
  onOpen: (mode: "category" | "split") => void;
  onSaved: (categoryId: string) => void;
  onSplitSaved: (split: boolean) => void;
  onApplied: (updated: number) => void;
  onClose: () => void;
}) {
  const { transaction: t, categories } = props;
  const categoryNames = categories.names;
  const name = t.counterparty || t.description || "Okänd motpart";
  const notes = [
    t.categoryId === null ? null : (categoryNames.get(t.categoryId) ?? null),
    t.status === "pending" ? "Preliminär" : null,
    t.isInternalTransfer ? "Intern överföring – räknas inte" : null,
    t.split ? "Uppdelad" : null,
    t.categoryId === null && !t.split ? "Okategoriserad" : null,
  ].filter((n): n is string => n !== null);
  return (
    <li className={t.isInternalTransfer ? "tx internal" : "tx"}>
      <div className="tx-main">
        <span className="tx-name">{name}</span>
        <span className={t.amountMinor > 0 ? "amount income" : "amount"}>{formatSek(t.amountMinor)}</span>
      </div>
      {notes.length > 0 && <small className="tx-notes">{notes.join(" · ")}</small>}
      {props.mode === null && (
        <div className="tx-actions">
          <button type="button" className="small" aria-label={`Ändra kategori för ${name}`} onClick={() => { props.onOpen("category"); }}>
            Ändra
          </button>
          <button type="button" className="small" aria-label={`Dela upp ${name}`} onClick={() => { props.onOpen("split"); }}>
            Dela upp
          </button>
        </div>
      )}
      {props.mode === "split" && (
        <div className="tx-editor">
          <SplitEditor transactionId={t.id} amountMinor={t.amountMinor} options={categories.options} onSaved={props.onSplitSaved} onClose={props.onClose} />
        </div>
      )}
      {props.mode === "category" && (
        <div className="tx-editor">
          <CategoryEditor
            transactionId={t.id}
            name={name}
            options={categories.options}
            onSaved={props.onSaved}
            onApplied={props.onApplied}
            onClose={props.onClose}
          />
        </div>
      )}
    </li>
  );
}

export function TransactionsView() {
  const [filters, setFilters] = useState<Filters>({ period: null, q: "", uncategorized: false });
  const [search, setSearch] = useState("");
  const [state, setState] = useState<ListState>({ kind: "loading" });
  const [categories, setCategories] = useState<Categories>({ names: new Map(), options: [] });
  const [editing, setEditing] = useState<{ id: string; mode: "category" | "split" } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
    void fetchPage(filters, null).then((page) => {
      if (!current) return;
      setState(page ? { kind: "ready", ...page, loadingMore: false } : { kind: "error" });
    });
    return () => {
      current = false;
    };
  }, [filters]);

  const loadMore = useCallback(async () => {
    if (state.kind !== "ready" || state.nextCursor === null) return;
    setState({ ...state, loadingMore: true });
    const page = await fetchPage(filters, state.nextCursor);
    setState(page ? { ...state, items: [...state.items, ...page.items], nextCursor: page.nextCursor, loadingMore: false } : { kind: "error" });
  }, [filters, state]);

  const period = state.kind === "ready" ? state.period : null;
  const update = (id: string, change: Partial<Transaction>) => {
    if (state.kind === "ready") setState({ ...state, items: state.items.map((t) => (t.id === id ? { ...t, ...change } : t)) });
  };
  // Hämtar om samma period, så att transaktioner som regeln ändrade visar sin nya kategori.
  const applied = (updated: number) => {
    setNotice(`${String(updated)} transaktioner fick den nya kategorin.`);
    setEditing(null);
    setFilters({ ...filters, period: period?.key ?? filters.period });
  };
  const go = (months: number) => {
    if (period) setFilters({ ...filters, period: shiftPeriodKey(period.key, months) });
  };
  const onSearch = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFilters({ ...filters, period: period?.key ?? filters.period, q: search });
  };

  return (
    <main>
      <h1>Transaktioner</h1>
      <p>
        <button type="button" disabled={!period} onClick={() => { go(-1); }}>
          Föregående period
        </button>{" "}
        <button type="button" disabled={!period} onClick={() => { go(1); }}>
          Nästa period
        </button>
      </p>
      {period && <p>Period {formatDateShort(period.start)} – {formatDateShort(period.end)}</p>}
      <form role="search" onSubmit={onSearch}>
        <input type="search" aria-label="Sök" placeholder="Sök motpart eller beskrivning" value={search} onChange={(e) => { setSearch(e.target.value); }} />{" "}
        <button type="submit">Sök</button>
      </form>
      <label>
        <input
          type="checkbox"
          checked={filters.uncategorized}
          onChange={(e) => { setFilters({ ...filters, period: period?.key ?? filters.period, uncategorized: e.target.checked }); }}
        />{" "}
        Bara okategoriserade
      </label>

      {notice && <p role="status">{notice}</p>}
      {state.kind === "loading" && <p>Hämtar…</p>}
      {state.kind === "error" && <p role="alert">Det gick inte att hämta transaktionerna. Försök igen om en stund.</p>}
      {state.kind === "ready" && state.items.length === 0 && <p>Inga transaktioner i perioden.</p>}
      {state.kind === "ready" && state.items.length > 0 && (
        <ul>
          {groupByDay(state.items).map(([day, items]) => (
            <li key={day} data-day={day}>
              <h2>{formatDateShort(day)}</h2>
              <ul>
                {items.map((t) => (
                  <Row
                    key={t.id}
                    transaction={t}
                    categories={categories}
                    mode={editing?.id === t.id ? editing.mode : null}
                    onOpen={(mode) => { setEditing({ id: t.id, mode }); }}
                    onSaved={(categoryId) => { update(t.id, { categoryId }); }}
                    onSplitSaved={(split) => { update(t.id, { split }); }}
                    onApplied={applied}
                    onClose={() => { setEditing(null); }}
                  />
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {state.kind === "ready" && state.nextCursor !== null && (
        <button type="button" disabled={state.loadingMore} onClick={() => void loadMore()}>
          {state.loadingMore ? "Hämtar…" : "Visa fler"}
        </button>
      )}
    </main>
  );
}
