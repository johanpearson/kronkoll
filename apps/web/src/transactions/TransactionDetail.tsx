// Detaljsidan för en transaktion (#32): allt om den, inklusive bankens råa text som ofta förklarar
// en okänd motpart, och åtgärderna Ändra kategori, Dela upp och Räkna inte som utgift (KK-20-C).
// Bankens text renderas alltid som text, aldrig som HTML (KK-30).
import { formatDateShort, formatSek } from "@kronkoll/domain";
import { useCallback, useEffect, useState } from "react";
import { field, getJson, putJson } from "../api.ts";
import { Link } from "../router.tsx";
import { CategoryEditor } from "./CategoryEditor.tsx";
import { SplitEditor } from "./SplitEditor.tsx";
import { fetchCategories, type Categories } from "./TransactionsView.tsx";

interface Detail {
  readonly id: string;
  readonly accountName: string;
  readonly status: string;
  readonly transactionDate: string;
  readonly bookingDate: string | null;
  readonly amountMinor: number;
  readonly counterparty: string;
  readonly counterpartyNorm: string;
  readonly description: string;
  readonly categoryId: string | null;
  readonly categorySource: string;
  readonly internal: boolean;
  readonly manualTransfer: boolean | null;
  readonly pair: { accountName: string; amountMinor: number; transactionDate: string } | null;
  readonly splits: readonly { categoryId: string; amountMinor: number }[];
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

function toDetail(body: unknown): Detail | null {
  const id = field(body, "id");
  const date = field(body, "transaction_date");
  const amount = field(body, "amount_minor");
  if (typeof id !== "string" || typeof date !== "string" || typeof amount !== "number") return null;
  const pair = field(body, "transfer_pair");
  const pairAmount = field(pair, "amount_minor");
  const splits = field(body, "splits");
  const booking = field(body, "booking_date");
  const category = field(body, "category_id");
  const manual = field(body, "manual_transfer");
  return {
    id,
    accountName: text(field(field(body, "account"), "name")),
    status: text(field(body, "status")),
    transactionDate: date,
    bookingDate: typeof booking === "string" ? booking : null,
    amountMinor: amount,
    counterparty: text(field(body, "counterparty")),
    counterpartyNorm: text(field(body, "counterparty_norm")),
    description: text(field(body, "description")),
    categoryId: typeof category === "string" ? category : null,
    categorySource: text(field(body, "category_source")),
    internal: field(body, "is_internal_transfer") === true,
    manualTransfer: typeof manual === "boolean" ? manual : null,
    pair: typeof pairAmount === "number" ? { accountName: text(field(pair, "account_name")), amountMinor: pairAmount, transactionDate: text(field(pair, "transaction_date")) } : null,
    splits: Array.isArray(splits)
      ? splits.flatMap((p) => {
          const c = field(p, "category_id");
          const a = field(p, "amount_minor");
          return typeof c === "string" && typeof a === "number" ? [{ categoryId: c, amountMinor: a }] : [];
        })
      : [],
  };
}

const SOURCE: Record<string, string> = { template: "mall", learned: "inlärd regel", manual: "vald av dig" };

function counting(d: Detail): string {
  if (d.manualTransfer === true) return "Inte som utgift (vald av dig)";
  if (d.manualTransfer === false) return "Som utgift (vald av dig)";
  return d.internal ? "Inte som utgift – intern överföring (automatiskt)" : "Som utgift";
}

type State = { kind: "loading" } | { kind: "missing" } | { kind: "error" } | { kind: "ready"; detail: Detail };

export function TransactionDetail({ id }: { id: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [categories, setCategories] = useState<Categories>({ names: new Map(), options: [] });
  const [mode, setMode] = useState<"category" | "split" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = `/api/transactions/${encodeURIComponent(id)}`;

  const load = useCallback(async () => {
    const { status, body } = await getJson(path);
    const detail = status === 200 ? toDetail(body) : null;
    setState(detail ? { kind: "ready", detail } : status === 404 ? { kind: "missing" } : { kind: "error" });
  }, [path]);

  useEffect(() => {
    void load();
    void fetchCategories().then(setCategories);
  }, [load]);

  const setTransfer = async (internal: boolean | null) => {
    setBusy(true);
    setError(null);
    const { status } = await putJson(`${path}/transfer`, { internal });
    setBusy(false);
    if (status === 200) await load();
    else setError("Det gick inte att spara. Försök igen.");
  };

  const back = (
    <p>
      <Link to="/transaktioner">Till transaktionerna</Link>
    </p>
  );
  if (state.kind === "loading") return <main>{back}<p>Hämtar…</p></main>;
  if (state.kind !== "ready") {
    return (
      <main>
        {back}
        <p role="alert">{state.kind === "missing" ? "Transaktionen finns inte." : "Det gick inte att hämta transaktionen. Försök igen om en stund."}</p>
      </main>
    );
  }

  const d = state.detail;
  const name = (id: string | null) => (id === null ? null : (categories.names.get(id) ?? id));
  const category = d.splits.length > 0 ? "Uppdelad" : d.categoryId === null ? "Okategoriserad" : `${name(d.categoryId) ?? ""} (${SOURCE[d.categorySource] ?? "okänd källa"})`;
  const close = () => {
    setMode(null);
    void load();
  };

  return (
    <main>
      {back}
      <h1>{d.counterparty || d.description || "Okänd motpart"}</h1>
      <p className={d.amountMinor > 0 ? "amount income big" : "amount big"}>{formatSek(d.amountMinor)}</p>
      <dl className="card facts">
        <div><dt>Datum</dt><dd>{formatDateShort(d.transactionDate)}</dd></div>
        <div><dt>Status</dt><dd>{d.status === "pending" ? "Preliminär – väntar på bokföring" : `Bokförd ${formatDateShort(d.bookingDate ?? d.transactionDate)}`}</dd></div>
        <div><dt>Konto</dt><dd>{d.accountName}</dd></div>
        <div><dt>Kategori</dt><dd>{category}</dd></div>
        <div><dt>Räknas</dt><dd>{counting(d)}</dd></div>
        {d.pair && (
          <div><dt>Motpost</dt><dd>{`${d.pair.accountName} · ${formatSek(d.pair.amountMinor)} · ${formatDateShort(d.pair.transactionDate)}`}</dd></div>
        )}
      </dl>

      {d.splits.length > 0 && (
        <ul aria-label="Uppdelning">
          {d.splits.map((p, i) => (
            <li key={`${p.categoryId}-${String(i)}`}>
              {name(p.categoryId)} <span className="amount">{formatSek(p.amountMinor)}</span>
            </li>
          ))}
        </ul>
      )}

      {error && <p role="alert">{error}</p>}
      {mode === null && (
        <p className="actions">
          <button type="button" onClick={() => { setMode("category"); }}>Ändra kategori</button>
          <button type="button" onClick={() => { setMode("split"); }}>Dela upp</button>
          {!d.internal && <button type="button" disabled={busy} onClick={() => void setTransfer(true)}>Räkna inte som utgift</button>}
          {d.internal && <button type="button" disabled={busy} onClick={() => void setTransfer(false)}>Räkna som utgift</button>}
          {d.manualTransfer !== null && <button type="button" disabled={busy} onClick={() => void setTransfer(null)}>Låt Kronkoll avgöra</button>}
        </p>
      )}
      {mode === "category" && (
        <section className="card tx-editor">
          <CategoryEditor transactionId={d.id} name={d.counterparty || "motparten"} options={categories.options} onSaved={() => undefined} onApplied={close} onClose={close} />
        </section>
      )}
      {mode === "split" && (
        <section className="card tx-editor">
          <SplitEditor transactionId={d.id} amountMinor={d.amountMinor} options={categories.options} onSaved={() => undefined} onClose={close} />
        </section>
      )}

      <section className="card" aria-label="Från banken">
        <h2>Från banken</h2>
        <dl className="facts">
          <div><dt>Motpart</dt><dd>{d.counterparty || "–"}</dd></div>
          <div><dt>Meddelande</dt><dd>{d.description || "–"}</dd></div>
          <div><dt>Matchas som</dt><dd>{d.counterpartyNorm || "–"}</dd></div>
        </dl>
      </section>
    </main>
  );
}
