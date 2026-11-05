// Sparmål (#39, KK-21): alla mål med hur mycket som är sparat, när de nås i nuvarande takt och om de
// är i fas med måldatumet. Namnet leder till målets sida.
import { formatSek } from "@kronkoll/domain";
import { useEffect, useState } from "react";
import { Link, navigate } from "../router.tsx";
import { fetchGoals, formatPeriod, goalBadge, type Goal } from "./goals.ts";

type State = { readonly kind: "loading" } | { readonly kind: "error" } | { readonly kind: "ready"; readonly goals: readonly Goal[] };

function GoalRow({ goal }: { goal: Goal }) {
  const badge = goalBadge(goal);
  const percent = Math.min(100, Math.floor((goal.savedMinor * 100) / goal.targetMinor));
  return (
    <li className="tx goal">
      <div className="tx-main">
        <span className="tx-name">
          <Link to={`/sparmal/${encodeURIComponent(goal.id)}`}>{goal.name}</Link>
        </span>
        {badge && <span className={`badge ${badge.tone}`}>{badge.text}</span>}
      </div>
      <progress className="budget-bar" aria-hidden="true" max={100} value={percent} />
      <small className="tx-notes">
        {formatSek(goal.savedMinor)} av {formatSek(goal.targetMinor)}
        {goal.forecast.kind === "eta" && ` · prognos ${formatPeriod(goal.forecast.reachPeriod)}`}
      </small>
    </li>
  );
}

export function GoalsView() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let current = true;
    void fetchGoals().then((goals) => {
      if (current) setState(goals ? { kind: "ready", goals } : { kind: "error" });
    });
    return () => {
      current = false;
    };
  }, []);

  return (
    <main>
      <h1>Sparmål</h1>
      <p className="actions">
        <button type="button" className="primary" onClick={() => { navigate("/sparmal/nytt"); }}>
          Nytt sparmål
        </button>
        <button type="button" onClick={() => { navigate("/sparmal/lan"); }}>
          Lån
        </button>
      </p>
      {state.kind === "loading" && <p>Hämtar…</p>}
      {state.kind === "error" && <p role="alert">Det gick inte att hämta sparmålen. Försök igen om en stund.</p>}
      {state.kind === "ready" && state.goals.length === 0 && (
        <section className="card">
          <p>Inga sparmål än. Sätt ett mål, så räknar Kronkoll ut när du når det i nuvarande takt.</p>
        </section>
      )}
      {state.kind === "ready" && state.goals.length > 0 && (
        <ul aria-label="Dina sparmål">
          {state.goals.map((g) => (
            <GoalRow key={g.id} goal={g} />
          ))}
        </ul>
      )}
    </main>
  );
}
