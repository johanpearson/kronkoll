// Ett sparmål (#39, KK-21): hur mycket som är sparat, prognos, måldatum och takt, vad som krävs per
// månad för att hinna, och avsättningarna. Mål med egna avsättningar får en ny avsättning eller ett
// uttag här; ett kontos mål följer saldot. Målet ändras eller tas bort med pennan, och en avsättning
// tas bort med papperskorgen (KK-21-C).
import { formatDateShort, formatSek } from "@kronkoll/domain";
import { Pencil, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, type SyntheticEvent } from "react";
import { deleteJson, field, postJson } from "../api.ts";
import { IconButton } from "../icon-button.tsx";
import { Link } from "../router.tsx";
import { useToast } from "../toast.tsx";
import { GoalEdit } from "./GoalEdit.tsx";
import { fetchGoal, formatMonthLong, formatPeriod, goalBadge, toGoal, type Goal } from "./goals.ts";
import { effectText, fetchLeaveEffects, type LeaveEffect } from "./leave-effect.ts";
import { parseKronor } from "./NewGoal.tsx";

type State = { readonly kind: "loading" } | { readonly kind: "missing" } | { readonly kind: "error" } | { readonly kind: "ready"; readonly goal: Goal };

/** Vad som krävs för att hinna till måldatum, när målet inte är i fas. */
function advice(goal: Goal): string | null {
  const f = goal.forecast;
  if (f.kind === "reached" || goal.targetDate === null || f.requiredMonthlyMinor === null) return null;
  if (f.kind === "eta" && f.onTrack === true) return null;
  const needed = `För att nå målet till ${formatMonthLong(goal.targetDate)} behövs ${formatSek(f.requiredMonthlyMinor)}/mån`;
  return f.kind === "never" ? `${needed}.` : `${needed} (nu ${formatSek(goal.monthlyRateMinor)}/mån).`;
}

function Deposit(props: { goalId: string; onSaved: (goal: Goal) => void }) {
  const toast = useToast();
  const [amount, setAmount] = useState("");
  const [withdrawal, setWithdrawal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const ore = parseKronor(amount);
    if (ore === null || ore === 0) {
      setError("Skriv beloppet i kronor, till exempel 3 000.");
      return;
    }
    setBusy(true);
    setError(null);
    const { status, body } = await postJson(`/api/goals/${encodeURIComponent(props.goalId)}/contributions`, { amount_minor: withdrawal ? -ore : ore });
    setBusy(false);
    const goal = status === 201 ? toGoal(body) : null;
    if (goal) {
      setAmount("");
      setWithdrawal(false);
      toast.done(withdrawal ? "Uttaget är sparat." : "Avsättningen är sparad.");
      props.onSaved(goal);
    } else setError(field(body, "error") === "goal_uses_account" ? "Målet följer ett kontos saldo och har inga egna avsättningar." : "Det gick inte att spara. Försök igen.");
  };

  return (
    <form className="card goal-form" aria-label="Ny avsättning" onSubmit={(e) => void save(e)}>
      <label>
        Belopp (kr)
        <input value={amount} inputMode="decimal" onChange={(e) => { setAmount(e.target.value); }} />
      </label>
      <label className="check">
        <input type="checkbox" checked={withdrawal} onChange={(e) => { setWithdrawal(e.target.checked); }} />
        Det är ett uttag
      </label>
      {error && <p role="alert">{error}</p>}
      <p className="actions">
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Sparar…" : "Lägg till"}
        </button>
      </p>
    </form>
  );
}

/** En avsättning med en knapp som frågar innan den tas bort (KK-21-C). */
function ContributionRow(props: { goalId: string; c: Goal["contributions"][number]; onRemoved: () => void }) {
  const toast = useToast();
  const { c } = props;
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState(false);
  const kind = c.amountMinor < 0 ? "Uttag" : "Avsättning";
  const the = c.amountMinor < 0 ? "uttaget" : "avsättningen";
  const remove = async () => {
    const { status } = await deleteJson(`/api/goals/${encodeURIComponent(props.goalId)}/contributions/${encodeURIComponent(c.id)}`);
    if (status === 204) {
      toast.done(c.amountMinor < 0 ? "Uttaget är borttaget." : "Avsättningen är borttagen.");
      props.onRemoved();
    } else setError(true);
  };
  return (
    <li className="tx">
      <div className="tx-main">
        <span className="tx-name">{kind}</span>
        <span className={c.amountMinor > 0 ? "amount income" : "amount"}>{formatSek(c.amountMinor)}</span>
      </div>
      <small className="tx-notes">{formatDateShort(c.date)}</small>
      {confirming ? (
        <div className="tx-editor">
          <p>Ta bort {the}? Sparat och takt räknas om.</p>
          {error && <p role="alert">Det gick inte att ta bort. Försök igen.</p>}
          <p className="actions">
            <button type="button" className="danger small" onClick={() => void remove()}>
              Ta bort
            </button>
            <button type="button" className="small" onClick={() => { setConfirming(false); }}>
              Behåll
            </button>
          </p>
        </div>
      ) : (
        c.id !== "" && (
          <div className="tx-actions">
            <IconButton label={`Ta bort ${kind.toLowerCase()} ${formatDateShort(c.date)}`} icon={Trash2} onClick={() => { setConfirming(true); }} />
          </div>
        )
      )}
    </li>
  );
}

export function GoalDetail({ id }: { id: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [effects, setEffects] = useState<readonly LeaveEffect[]>([]);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    const goal = await fetchGoal(id);
    setState(goal === null ? { kind: "missing" } : goal === "error" ? { kind: "error" } : { kind: "ready", goal });
  }, [id]);

  useEffect(() => {
    void load();
    // Ledigheten är ett tillägg: går den inte att hämta visas målet ändå, utan den.
    void fetchLeaveEffects(id).then(setEffects);
  }, [load, id]);

  const back = (
    <p>
      <Link to="/sparmal">‹ Sparmål</Link>
    </p>
  );
  if (state.kind === "loading") return <main>{back}<p>Hämtar…</p></main>;
  if (state.kind !== "ready") {
    return (
      <main>
        {back}
        <p role="alert">{state.kind === "missing" ? "Sparmålet finns inte." : "Det gick inte att hämta sparmålet. Försök igen om en stund."}</p>
      </main>
    );
  }

  const goal = state.goal;
  const f = goal.forecast;
  const badge = goalBadge(goal);
  const percent = Math.min(100, Math.floor((goal.savedMinor * 100) / goal.targetMinor));
  const tip = advice(goal);
  return (
    <main>
      {back}
      <div className="page-header">
        <h1>{goal.name}</h1>
        {!editing && <IconButton label="Ändra sparmål" icon={Pencil} onClick={() => { setEditing(true); }} />}
      </div>
      {editing && (
        <GoalEdit
          goal={goal}
          onSaved={(saved) => {
            setEditing(false);
            setState({ kind: "ready", goal: saved });
          }}
          onClose={() => { setEditing(false); }}
        />
      )}
      <section className="card">
        <p className="goal-progress">
          {formatSek(goal.savedMinor)} av {formatSek(goal.targetMinor)} ({percent} %)
          {badge && <span className={`badge ${badge.tone}`}>{badge.text}</span>}
        </p>
        <progress className="budget-bar" aria-hidden="true" max={100} value={percent} />
      </section>
      <dl className="card stats">
        <div>
          <dt>Prognos</dt>
          <dd>{f.kind === "eta" ? formatPeriod(f.reachPeriod) : f.kind === "reached" ? "Nått" : "Nås inte"}</dd>
        </div>
        <div>
          <dt>Måldatum</dt>
          <dd>{goal.targetDate === null ? "Inget" : formatPeriod(goal.targetDate.slice(0, 7))}</dd>
        </div>
        <div>
          <dt>Takt</dt>
          <dd>{formatSek(goal.monthlyRateMinor)}/mån</dd>
        </div>
      </dl>
      {goal.accountMissing && <p role="alert">Kontot som målet följde finns inte längre, så inget räknas som sparat.</p>}
      {f.kind === "never" && !goal.accountMissing && <p className="note" role="note">Nås inte i nuvarande takt – inget sparat de senaste 3 månaderna.</p>}
      {tip && <p className="note" role="note">{tip}</p>}
      {effects.map((e) => (
        <p key={`${e.from}-${e.to}`} className="note" role="note">
          {effectText(e)}
        </p>
      ))}
      {goal.source === "account" ? (
        !goal.accountMissing && <p>Saldot på kontot räknas som sparat. Takten är snittet av insättningar och uttag de senaste 3 månaderna.</p>
      ) : (
        <>
          <h2>Avsättningar</h2>
          {goal.contributions.length === 0 ? (
            <p>Inga avsättningar än.</p>
          ) : (
            <ul aria-label="Avsättningar">
              {goal.contributions.map((c, i) => (
                <ContributionRow key={c.id === "" ? `${c.date}-${String(i)}` : c.id} goalId={goal.id} c={c} onRemoved={() => void load()} />
              ))}
            </ul>
          )}
          <Deposit goalId={goal.id} onSaved={(saved) => { setState({ kind: "ready", goal: saved }); }} />
        </>
      )}
    </main>
  );
}
