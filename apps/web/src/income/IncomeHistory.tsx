// Inkomsthistorik (#40, KK-22-B): netto per månad de senaste tolv månaderna, uppdelat på lön,
// föräldrapenning och övrigt, nyast först. Klassningen görs i synken (#198); här visas bara summorna.
import { formatSek } from "@kronkoll/domain";
import { useEffect, useState } from "react";
import { field, getJson } from "../api.ts";

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

function MonthRow({ m }: { m: IncomeMonth }) {
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
    </li>
  );
}

type State = { readonly kind: "loading" } | { readonly kind: "error" } | { readonly kind: "ready"; readonly months: readonly IncomeMonth[] };

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
