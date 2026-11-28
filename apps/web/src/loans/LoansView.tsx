// Lån (#72, KK-36) i ny design (#257): ett kort per lån med månadskostnad, skuld, ränta, bindningstid och amortering,
// ett stapeldiagram över ränta och amortering och Betalt denna period (KK-59-C). Lånen läggs in och ändras i ett ark.
// Beräkningarna görs i API:t med domänen; lånebetalningarna räknas hela som boendekostnad i budgeten (D-loans).
import { formatDateShort, formatSek } from "@kronkoll/domain";
import { Landmark, Pencil, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { field, getJson } from "../api.ts";
import { Button, IconButton } from "../ui/Button.tsx";
import { BarChart } from "../ui/charts/Charts.tsx";
import { Chip } from "../ui/Chip.tsx";
import { Sheet } from "../ui/Modal.tsx";
import { Card, EmptyState, Skeleton } from "../ui/Surface.tsx";
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

function RateStatus({ loan }: { loan: Loan }) {
  if (!loan.rateFixed) return <p className="ui-caption">Rörlig ränta</p>;
  if (loan.ending) return <Chip tone="warning">{loan.daysLeft === 0 ? "Bindningstiden slutar i dag" : `Bindningstiden slutar om ${String(loan.daysLeft)} dagar`}</Chip>;
  return <p className="ui-caption">{`Bunden ränta i ${String(loan.daysLeft)} dagar till`}</p>;
}

/** Betalt denna period jämfört med månadskostnaden, och en varning i text när inget har kommit (KK-59-C). */
function Paid({ loan }: { loan: Loan }) {
  const { paid } = loan;
  if (paid.lastPaidOn !== null) {
    return <p className="ui-body loan-paid">{`Betalt denna period: ${formatSek(paid.paidMinor)} av ${formatSek(loan.costMinor)}, senast ${formatDateShort(paid.lastPaidOn)}`}</p>;
  }
  if (paid.missing) return <Chip tone="danger">Ingen betalning har kommit denna period</Chip>;
  // Utan kontouppgifter kopplas inga betalningar, så det finns inget att säga om perioden.
  return loan.matchPatterns.length > 0 ? <p className="ui-caption">Ingen betalning än denna period</p> : null;
}

function LoanCard({ loan, onEdit }: { loan: Loan; onEdit: () => void }) {
  return (
    <Card title={loan.name} action={<IconButton label={`Ändra ${loan.name}`} icon={Pencil} onClick={onEdit} />}>
      {loan.lender !== null && <p className="ui-caption">{loan.lender}</p>}
      <p className="ui-amount loan-cost">{`${formatSek(loan.costMinor)}/mån`}</p>
      <p className="ui-caption">
        Skuld {formatSek(loan.balanceMinor)} · {formatRate(loan.interestRateBp)} · ränta {formatSek(loan.interestMinor)} + amortering {formatSek(loan.amortizationMinor)}
      </p>
      <RateStatus loan={loan} />
      <Paid loan={loan} />
      <BarChart
        label={`Månadskostnaden för ${loan.name}`}
        bars={[
          { label: "Ränta", valueMinor: loan.interestMinor },
          { label: "Amortering", valueMinor: loan.amortizationMinor },
        ]}
      />
    </Card>
  );
}

type State = { readonly kind: "loading" } | { readonly kind: "error" } | { readonly kind: "ready"; readonly data: Loans };
/** Arket: ett nytt lån (null) eller ett lån som ändras. */
type Editing = { readonly loan: Loan | null } | null;

export function LoansView() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [editing, setEditing] = useState<Editing>(null);

  const load = useCallback(async () => {
    const data = await fetchLoans();
    setState(data ? { kind: "ready", data } : { kind: "error" });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const add = (
    <Button variant="primary" icon={Plus} onClick={() => { setEditing({ loan: null }); }}>
      Lägg till lån
    </Button>
  );

  return (
    <main>
      <div className="page-header">
        <h1>Lån</h1>
      </div>
      {state.kind === "loading" && <Skeleton lines={4} />}
      {state.kind === "error" && <p role="alert">Det gick inte att hämta lånen. Försök igen om en stund.</p>}
      {state.kind === "ready" && state.data.loans.length === 0 && (
        <EmptyState title="Inga lån än" icon={Landmark} action={add}>
          Lägg till dina lån för att se skuld, ränta och månadskostnad. Ett bolån i flera delar läggs in som ett lån per del.
        </EmptyState>
      )}
      {state.kind === "ready" && state.data.loans.length > 0 && (
        <div className="ui-stack">
          <Card>
            <dl className="loan-totals">
              <div>
                <dt className="ui-caption">Total skuld</dt>
                <dd className="ui-amount">{formatSek(state.data.totalBalanceMinor)}</dd>
              </div>
              <div>
                <dt className="ui-caption">Kostnad per månad</dt>
                <dd className="ui-amount">{formatSek(state.data.totalCostMinor)}</dd>
              </div>
            </dl>
            <p className="ui-caption" role="note">
              Varje månad: {formatSek(state.data.totalInterestMinor)} ränta och {formatSek(state.data.totalAmortizationMinor)} amortering. Lånebetalningarna räknas hela som boendekostnad i budgeten.
            </p>
          </Card>
          <ul className="account-list" aria-label="Dina lån">
            {state.data.loans.map((l) => (
              <li key={l.id}>
                <LoanCard loan={l} onEdit={() => { setEditing({ loan: l }); }} />
              </li>
            ))}
          </ul>
          <p>{add}</p>
        </div>
      )}
      <Sheet open={editing !== null} title={editing?.loan ? `Ändra ${editing.loan.name}` : "Nytt lån"} onClose={() => { setEditing(null); }}>
        {editing !== null && (
          <LoanForm
            loan={editing.loan}
            onSaved={() => {
              setEditing(null);
              void load();
            }}
            onClose={() => { setEditing(null); }}
          />
        )}
      </Sheet>
    </main>
  );
}
