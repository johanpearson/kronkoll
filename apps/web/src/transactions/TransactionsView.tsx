// Transaktionslistan (#32, KK-4, KK-9, KK-30): en budgetperiod i taget, grupperad per dag, nyast
// först. Bankens text renderas alltid som text, aldrig som HTML. Kategorin visas med namn, t.ex.
// "Mat › Livsmedel". Byte av kategori och uppdelning kommer i egna PR:er.
import { formatDateShort, formatSek } from "@kronkoll/domain";
import { useCallback, useEffect, useState, type SyntheticEvent } from "react";
import { field, getJson } from "../api.ts";

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

/** Kategorinamn per id, t.ex. "Mat › Livsmedel", eller en tom karta om kategorierna inte går att hämta. */
async function fetchCategoryNames(): Promise<ReadonlyMap<string, string>> {
  const { status, body } = await getJson("/api/categories");
  const items = field(body, "items");
  if (status !== 200 || !Array.isArray(items)) return new Map();
  const names = new Map<string, { name: string; parent: string | null }>();
  for (const item of items) {
    const id = field(item, "id");
    const name = field(item, "name");
    const parent = field(item, "parent_id");
    if (typeof id === "string" && typeof name === "string") names.set(id, { name, parent: typeof parent === "string" ? parent : null });
  }
  return new Map(
    [...names].map(([id, { name, parent }]) => {
      const parentName = parent === null ? undefined : names.get(parent)?.name;
      return [id, parentName === undefined ? name : `${parentName} › ${name}`];
    }),
  );
}

function Row({ transaction: t, categoryNames }: { transaction: Transaction; categoryNames: ReadonlyMap<string, string> }) {
  const notes = [
    t.categoryId === null ? null : (categoryNames.get(t.categoryId) ?? null),
    t.status === "pending" ? "Preliminär" : null,
    t.isInternalTransfer ? "Intern överföring – räknas inte" : null,
    t.split ? "Uppdelad" : null,
    t.categoryId === null && !t.split ? "Okategoriserad" : null,
  ].filter((n): n is string => n !== null);
  return (
    <li className={t.isInternalTransfer ? "internal" : undefined}>
      <span>{t.counterparty || t.description || "Okänd motpart"}</span> <span>{formatSek(t.amountMinor)}</span>
      {notes.length > 0 && <small> · {notes.join(" · ")}</small>}
    </li>
  );
}

export function TransactionsView() {
  const [filters, setFilters] = useState<Filters>({ period: null, q: "", uncategorized: false });
  const [search, setSearch] = useState("");
  const [state, setState] = useState<ListState>({ kind: "loading" });
  const [categoryNames, setCategoryNames] = useState<ReadonlyMap<string, string>>(new Map());

  useEffect(() => {
    let current = true;
    void fetchCategoryNames().then((names) => {
      if (current) setCategoryNames(names);
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
                  <Row key={t.id} transaction={t} categoryNames={categoryNames} />
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
