// Lån (#72, KK-36): alla lån med skuld, ränta, bindningstid, amortering och månadskostnad, totalsummor och
// hur kostnaden fördelar sig på ränta och amortering. Lånen läggs in, ändras och tas bort här. Beräkningarna
// görs i API:t med domänen; lånebetalningarna räknas hela som boendekostnad i budgeten (D-loans).
import { formatSek } from "@kronkoll/domain";
import { Pencil } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { field, getJson } from "../api.ts";
import { IconButton } from "../icon-button.tsx";
import { Link } from "../router.tsx";
import { LoanForm } from "./LoanForm.tsx";
import { formatRate, toLoan, type Loan } from "./loan.ts";

interface Loans {
  readonly loans: readonly Loan[];
  readonly totalBalanceMinor: number;
  readonly totalInterestMinor: number;
  readonly totalAmortizationMinor: number;
  readonly totalCostMinor: number;
}

const int = (v: unknown) => (Number.isSafeInteger(v) ? (v as number) : 0);

async function fetchLoans(): Promise<Loans | null> {
  const { status, body } = await getJson("/api/loans");
  const list = field(body, "loans");
  if (status !== 200 || !Array.isArray(list)) return null;
  return {
    loans: list.map(toLoan).filter((l): l is Loan => l !== null),
    totalBalanceMinor: int(field(body, "total_balance_minor")),
    totalInterestMinor: int(field(body, "total_monthly_interest_minor")),
    totalAmortizationMinor: int(field(body, "total_monthly_amortization_minor")),
    totalCostMinor: int(field(body, "total_monthly_cost_minor")),
  };
}

function rateText(loan: Loan): { text: string; tone: "warn" | null } {
  if (!loan.rateFixed) return { text: "Rörlig ränta", tone: null };
  if (loan.ending) return { text: loan.daysLeft === 0 ? "Bindningstiden slutar i dag" : `Bindningstiden slutar om ${String(loan.daysLeft)} dagar`, tone: "warn" };
  return { text: `Bunden ränta i ${String(loan.daysLeft)} dagar till`, tone: null };
}

function LoanRow(props: { loan: Loan; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const l = props.loan;
  const rate = rateText(l);
  return (
    <li className="tx">
      <div className="tx-main">
        <span className="tx-name">{l.lender ? `${l.name} · ${l.lender}` : l.name}</span>
        <span className="amount">{formatSek(l.costMinor)}/mån</span>
      </div>
      <small className="tx-notes">
        Skuld {formatSek(l.balanceMinor)} · {formatRate(l.interestRateBp)} · ränta {formatSek(l.interestMinor)} + amortering {formatSek(l.amortizationMinor)}
      </small>
      {rate.tone ? <span className="badge warn">{rate.text}</span> : <small className="tx-notes">{rate.text}</small>}
      {editing ? (
        <LoanForm loan={l} onSaved={() => { setEditing(false); props.onSaved(); }} onClose={() => { setEditing(false); }} />
      ) : (
        <div className="tx-actions">
          <IconButton label={`Ändra ${l.name}`} icon={Pencil} onClick={() => { setEditing(true); }} />
        </div>
      )}
    </li>
  );
}

type State = { readonly kind: "loading" } | { readonly kind: "error" } | { readonly kind: "ready"; readonly data: Loans };

export function LoansView() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    const data = await fetchLoans();
    setState(data ? { kind: "ready", data } : { kind: "error" });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main>
      <p>
        <Link to="/sparmal">‹ Sparmål</Link>
      </p>
      <h1>Lån</h1>
      {state.kind === "loading" && <p>Hämtar…</p>}
      {state.kind === "error" && <p role="alert">Det gick inte att hämta lånen. Försök igen om en stund.</p>}
      {state.kind === "ready" && state.data.loans.length > 0 && (
        <>
          <dl className="card stats">
            <div>
              <dt>Total skuld</dt>
              <dd>{formatSek(state.data.totalBalanceMinor)}</dd>
            </div>
            <div>
              <dt>Kostnad per månad</dt>
              <dd>{formatSek(state.data.totalCostMinor)}</dd>
            </div>
          </dl>
          <ul aria-label="Dina lån">
            {state.data.loans.map((l) => (
              <LoanRow key={l.id} loan={l} onSaved={() => void load()} />
            ))}
          </ul>
          <p className="note" role="note">
            Varje månad: {formatSek(state.data.totalInterestMinor)} ränta och {formatSek(state.data.totalAmortizationMinor)} amortering. Lånebetalningarna räknas hela som boendekostnad i budgeten.
          </p>
        </>
      )}
      {state.kind === "ready" && state.data.loans.length === 0 && !adding && (
        <section className="card">
          <p>Lägg till dina lån för att se skuld, ränta och månadskostnad. Ett bolån i flera delar läggs in som ett lån per del.</p>
        </section>
      )}
      {state.kind === "ready" &&
        (adding ? (
          <section className="card">
            <LoanForm loan={null} onSaved={() => { setAdding(false); void load(); }} onClose={() => { setAdding(false); }} />
          </section>
        ) : (
          <p>
            <button type="button" className="primary" onClick={() => { setAdding(true); }}>
              Lägg till lån
            </button>
          </p>
        ))}
    </main>
  );
}
