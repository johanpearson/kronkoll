// Inkomst (#40, KK-23): planerad föräldraledighet med uppskattad inkomst per månad, skillnaden mot en
// normal månad och vad som saknas mot budgeten. Uppskattningen räknas i API:t (GET /api/leave-periods)
// och är aldrig ett besked från Försäkringskassan. Inkomsthistoriken och formuläret kommer i egna PR:er.
import { formatDateShort, formatSek } from "@kronkoll/domain";
import { useEffect, useState } from "react";
import { field, getJson } from "../api.ts";

export interface LeavePlan {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly daysPerWeek: number;
  readonly topupPct: number;
  readonly disclaimer: string;
  /** Snitt per månad under ledigheten, netto. */
  readonly averageIncomeMinor: number;
  /** Snitt per månad jämfört med en normal månad, negativt när det blir mindre. */
  readonly averageDeltaMinor: number;
  /** Största underskottet mot budgeten under en månad, 0 om inkomsten räcker. */
  readonly worstShortfallMinor: number;
  readonly fallbackYears: boolean;
}

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const list = (value: unknown) => (Array.isArray(value) ? (value as unknown[]) : []);
const average = (values: number[]) => (values.length === 0 ? 0 : Math.round(values.reduce((a, b) => a + b, 0) / values.length));

export function toLeavePlan(raw: unknown): LeavePlan | null {
  const id = field(raw, "id");
  const from = field(raw, "from");
  const to = field(raw, "to");
  if (typeof id !== "string" || typeof from !== "string" || typeof to !== "string") return null;
  const estimate = field(raw, "estimate");
  const months = list(field(estimate, "months"));
  const disclaimer = field(estimate, "disclaimer");
  return {
    id,
    from,
    to,
    daysPerWeek: num(field(raw, "days_per_week")),
    topupPct: num(field(raw, "employer_topup_pct")),
    disclaimer: typeof disclaimer === "string" ? disclaimer : "Uppskattning – inte ett besked från Försäkringskassan",
    averageIncomeMinor: average(months.map((m) => num(field(m, "income_minor")))),
    averageDeltaMinor: average(months.map((m) => num(field(m, "delta_vs_normal_minor")))),
    worstShortfallMinor: Math.max(0, ...list(field(raw, "impacts")).filter((i) => field(i, "type") === "budget").map((i) => num(field(i, "shortfall_minor")))),
    fallbackYears: months.some((m) => field(m, "params_fallback") === true),
  };
}

async function fetchPlans(): Promise<LeavePlan[] | null> {
  const { status, body } = await getJson("/api/leave-periods");
  const items = field(body, "items");
  if (status !== 200 || !Array.isArray(items)) return null;
  return items.map(toLeavePlan).filter((p): p is LeavePlan => p !== null);
}

const decimal = (n: number) => String(n).replace(".", ",");

function PlanRow({ plan }: { plan: LeavePlan }) {
  const notes = [`${decimal(plan.daysPerWeek)} ${plan.daysPerWeek === 1 ? "dag" : "dagar"}/vecka`];
  if (plan.topupPct > 0) notes.push(`föräldralön ${decimal(plan.topupPct)} %`);
  return (
    <li className="tx">
      <div className="tx-main">
        <span className="tx-name">
          {formatDateShort(plan.from)} – {formatDateShort(plan.to)}
        </span>
        <span className="amount">≈ {formatSek(plan.averageIncomeMinor)}/mån</span>
      </div>
      <small className="tx-notes">{notes.join(" · ")}</small>
      {plan.averageDeltaMinor < 0 && <span className="badge warn">{formatSek(plan.averageDeltaMinor)}/mån mot en vanlig månad</span>}
      {plan.worstShortfallMinor > 0 && <span className="badge bad">Underskott mot budget upp till {formatSek(plan.worstShortfallMinor)}/mån</span>}
      {plan.fallbackYears && <small className="tx-notes">Försäkringskassans belopp för ett senare år finns inte än, så det senaste kända året används.</small>}
    </li>
  );
}

type State = { readonly kind: "loading" } | { readonly kind: "error" } | { readonly kind: "ready"; readonly plans: readonly LeavePlan[] };

export function IncomeView() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let current = true;
    void fetchPlans().then((plans) => {
      if (current) setState(plans ? { kind: "ready", plans } : { kind: "error" });
    });
    return () => {
      current = false;
    };
  }, []);

  return (
    <main>
      <h1>Inkomst</h1>
      <h2>Planerad ledighet</h2>
      {state.kind === "loading" && <p>Hämtar…</p>}
      {state.kind === "error" && <p role="alert">Det gick inte att hämta den planerade ledigheten. Försök igen om en stund.</p>}
      {state.kind === "ready" && state.plans.length === 0 && (
        <section className="card">
          <p>Ingen ledighet är planerad.</p>
        </section>
      )}
      {state.kind === "ready" && state.plans.length > 0 && (
        <>
          <ul aria-label="Planerade perioder">
            {state.plans.map((p) => (
              <PlanRow key={p.id} plan={p} />
            ))}
          </ul>
          <p className="note" role="note">
            {state.plans[0]?.disclaimer}. Beloppen är netto efter skatt.
          </p>
        </>
      )}
    </main>
  );
}
