// Inkomsthistorik (#40, KK-22-B): netto per månad de senaste tolv månaderna, uppdelat på lön,
// föräldrapenning och övrigt, som staplat diagram och som lista, nyast först. Klassningen görs i synken
// (#198). Ett tryck på en månad visar inbetalningarna som räknas som inkomst den månaden (KK-46).
import { formatDateShort, formatSek } from "@kronkoll/domain";
import { useEffect, useState } from "react";
import { field, getJson } from "../api.ts";
import { Link } from "../router.tsx";
import { incomeLabel, type IncomeType } from "../transactions/IncomeType.tsx";

export interface IncomeMonth {
  readonly period: string;
  readonly salaryMinor: number;
  readonly benefitMinor: number;
  readonly otherMinor: number;
}

const int = (v: unknown) => (Number.isSafeInteger(v) ? (v as number) : 0);

export function toIncomeMonths(body: unknown): IncomeMonth[] | null {
  const months = field(body, "months");
  if (!Array.isArray(months)) return null;
  return months
    .flatMap((m) => {
      const period = field(m, "period");
      return typeof period === "string"
        ? [{ period, salaryMinor: int(field(m, "salary_minor")), benefitMinor: int(field(m, "parental_benefit_minor")), otherMinor: int(field(m, "other_minor")) }]
        : [];
    })
    .sort((a, b) => b.period.localeCompare(a.period));
}

const MONTH = new Intl.DateTimeFormat("sv-SE", { month: "long", year: "numeric", timeZone: "UTC" });
const monthName = (period: string) => MONTH.format(new Date(`${period}-01T00:00:00Z`)).replace(/^./u, (c) => c.toUpperCase());

interface IncomeItem {
  readonly id: string;
  readonly date: string;
  readonly amountMinor: number;
  readonly name: string;
  readonly type: IncomeType | null;
  readonly source: string;
  readonly pending: boolean;
}

const TYPES = new Set<unknown>(["salary", "parental_benefit", "other"]);

/** Posterna bakom en månad. Banktexterna är opålitlig indata och visas bara som text (KK-30). */
function toItems(body: unknown): IncomeItem[] | null {
  const items = field(body, "items");
  if (!Array.isArray(items)) return null;
  return items.flatMap((raw): IncomeItem[] => {
    const id = field(raw, "id");
    const date = field(raw, "date");
    const amount = field(raw, "amount_minor");
    if (typeof id !== "string" || typeof date !== "string" || !Number.isSafeInteger(amount)) return [];
    const counterparty = field(raw, "counterparty");
    const description = field(raw, "description");
    const type = field(raw, "income_type");
    const source = field(raw, "income_source");
    const name = [counterparty, description].find((t): t is string => typeof t === "string" && t.trim() !== "") ?? "Okänd avsändare";
    return [{ id, date, amountMinor: amount as number, name, type: TYPES.has(type) ? (type as IncomeType) : null, source: typeof source === "string" ? source : "", pending: field(raw, "status") === "pending" }];
  });
}

type ItemsState = { readonly kind: "loading" } | { readonly kind: "error" } | { readonly kind: "ready"; readonly items: readonly IncomeItem[] };

function MonthItems({ period }: { period: string }) {
  const [state, setState] = useState<ItemsState>({ kind: "loading" });
  useEffect(() => {
    let current = true;
    void getJson(`/api/income/${encodeURIComponent(period)}`).then(({ status, body }) => {
      const items = status === 200 ? toItems(body) : null;
      if (current) setState(items ? { kind: "ready", items } : { kind: "error" });
    });
    return () => {
      current = false;
    };
  }, [period]);
  if (state.kind === "loading") return <p>Hämtar…</p>;
  if (state.kind === "error") return <p role="alert">Det gick inte att hämta inbetalningarna. Försök igen om en stund.</p>;
  if (state.items.length === 0) return <p>Inga inbetalningar räknas som inkomst den månaden.</p>;
  return (
    <ul aria-label={`Inbetalningar ${monthName(period)}`} className="income-items">
      {state.items.map((i) => (
        <li key={i.id}>
          <div className="tx-main">
            <span className="tx-name">
              <Link to={`/transaktioner/${encodeURIComponent(i.id)}`}>{i.name}</Link>
            </span>
            <span className="amount">{formatSek(i.amountMinor)}</span>
          </div>
          <small className="tx-notes">
            {formatDateShort(i.date)} · {incomeLabel(i.type, i.source)}
            {i.pending ? " · Preliminär – väntar på bokföring" : ""}
          </small>
        </li>
      ))}
    </ul>
  );
}

function MonthRow({ m }: { m: IncomeMonth }) {
  const [open, setOpen] = useState(false);
  const parts = [
    ["Lön", m.salaryMinor],
    ["Föräldrapenning", m.benefitMinor],
    ["Övrigt", m.otherMinor],
  ].filter(([, amount]) => amount !== 0) as [string, number][];
  return (
    <li className="tx">
      <div className="tx-main">
        <span className="tx-name">{monthName(m.period)}</span>
        <span className="amount">{formatSek(m.salaryMinor + m.benefitMinor + m.otherMinor)}</span>
      </div>
      <small className="tx-notes">{parts.length === 0 ? "Ingen inkomst" : parts.map(([label, amount]) => `${label} ${formatSek(amount)}`).join(" · ")}</small>
      {parts.length > 0 && (
        <p>
          <button type="button" className="small" aria-expanded={open} onClick={() => { setOpen(!open); }}>
            {open ? `Dölj det som räknas i ${monthName(m.period).toLowerCase()}` : `Visa det som räknas i ${monthName(m.period).toLowerCase()}`}
          </button>
        </p>
      )}
      {open && <MonthItems period={m.period} />}
    </li>
  );
}

type State = { readonly kind: "loading" } | { readonly kind: "error" } | { readonly kind: "ready"; readonly months: readonly IncomeMonth[] };

const SHORT = new Intl.DateTimeFormat("sv-SE", { month: "short", timeZone: "UTC" });
const short = (period: string) => SHORT.format(new Date(`${period}-01T00:00:00Z`)).replace(".", "").toUpperCase();

/**
 * Staplat diagram per månad, äldst till vänster (KK-22-B): lön, föräldrapenning och övrigt. Diagrammet är
 * en bild för den som ser; listan under har samma belopp som text, så skärmläsare hoppar över bilden.
 */
export function IncomeChart({ months }: { months: readonly IncomeMonth[] }) {
  const ordered = [...months].reverse();
  const total = (m: IncomeMonth) => m.salaryMinor + m.benefitMinor + m.otherMinor;
  const max = Math.max(1, ...ordered.map(total));
  const height = 80;
  const px = (value: number) => (Math.max(0, value) / max) * height;
  // Alltid minst tolv kolumner, med den senaste månaden längst till höger, så att diagrammet har samma höjd.
  const columns = Math.max(12, ordered.length);
  const offset = (columns - ordered.length) * 24;
  return (
    <figure className="card trend income-chart">
      <figcaption>
        Netto per månad
        <span className="legend" aria-hidden="true">
          <span className="salary">Lön</span> <span className="benefit">Föräldrapenning</span> <span className="other">Övrigt</span>
        </span>
      </figcaption>
      <svg viewBox={`0 0 ${String(columns * 24)} ${String(height + 14)}`} aria-hidden="true">
        {ordered.map((m, i) => {
          const salary = px(m.salaryMinor);
          const benefit = px(m.benefitMinor);
          const other = px(m.otherMinor);
          return (
            <g key={m.period} transform={`translate(${String(offset + i * 24)} 0)`}>
              <rect className="salary" x="5" y={height - salary} width="14" height={salary} />
              <rect className="benefit" x="5" y={height - salary - benefit} width="14" height={benefit} />
              <rect className="other" x="5" y={height - salary - benefit - other} width="14" height={other} />
              <text x="12" y={height + 12} textAnchor="middle">
                {short(m.period)}
              </text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

export function IncomeHistory() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let current = true;
    void getJson("/api/income").then(({ status, body }) => {
      const months = status === 200 ? toIncomeMonths(body) : null;
      if (current) setState(months ? { kind: "ready", months } : { kind: "error" });
    });
    return () => {
      current = false;
    };
  }, []);

  return (
    <>
      <h2>Historik</h2>
      {state.kind === "loading" && <p>Hämtar…</p>}
      {state.kind === "error" && <p role="alert">Det gick inte att hämta inkomsterna. Försök igen om en stund.</p>}
      {state.kind === "ready" && (
        <>
          {state.months.some((m) => m.salaryMinor + m.benefitMinor + m.otherMinor > 0) && <IncomeChart months={state.months} />}
          <ul aria-label="Inkomst per månad">
            {state.months.map((m) => (
              <MonthRow key={m.period} m={m} />
            ))}
          </ul>
          <p>Netto efter skatt, så som det kommer in på kontot.</p>
        </>
      )}
    </>
  );
}
