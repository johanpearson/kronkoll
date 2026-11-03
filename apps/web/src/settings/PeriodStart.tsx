// Dagen budgetperioden börjar (#34, KK-34): den 1:a ger kalendermånaden, en senare dag till exempel
// lönedagen. Valet sparas direkt, och vyn visar perioden som pågår med det valet. Budget, översikt
// och transaktioner följer med, eftersom servern räknar perioden.
import { formatDateShort } from "@kronkoll/domain";
import { useEffect, useState } from "react";
import { field, getJson, patchJson } from "../api.ts";
import { toPeriod, type Period } from "../transactions/TransactionsView.tsx";

const DAYS = Array.from({ length: 28 }, (_, i) => i + 1);

/** "1:a", "2:a", "21:a", "22:a", annars ":e", även "11:e" och "12:e" (elfte, tolfte). */
export function ordinal(day: number): string {
  const a = (day % 10 === 1 || day % 10 === 2) && day !== 11 && day !== 12;
  return `${String(day)}:${a ? "a" : "e"}`;
}

const label = (day: number) => (day === 1 ? "Den 1:a (kalendermånad)" : `Den ${ordinal(day)}`);

type State =
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | { readonly kind: "ready"; readonly day: number; readonly period: Period; readonly saving: boolean; readonly message: string | null };

function parse(body: unknown): { day: number; period: Period } | null {
  const day = field(body, "budget_period_start_day");
  const period = toPeriod(field(body, "current_period"));
  return typeof day === "number" && period ? { day, period } : null;
}

export function PeriodStart() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let current = true;
    void getJson("/api/settings").then(({ status, body }) => {
      if (!current) return;
      const parsed = status === 200 ? parse(body) : null;
      setState(parsed ? { kind: "ready", ...parsed, saving: false, message: null } : { kind: "error" });
    });
    return () => {
      current = false;
    };
  }, []);

  if (state.kind === "loading") return <p>Hämtar…</p>;
  if (state.kind === "error") return <p role="alert">Det gick inte att hämta inställningen. Försök igen om en stund.</p>;

  const choose = async (day: number) => {
    setState({ ...state, day, saving: true, message: null });
    const { status, body } = await patchJson("/api/settings", { budget_period_start_day: day });
    const parsed = status === 200 ? parse(body) : null;
    setState(
      parsed
        ? { kind: "ready", ...parsed, saving: false, message: "Sparat." }
        : { ...state, saving: false, message: "Det gick inte att spara. Försök igen." },
    );
  };

  return (
    <div className="period-start">
      <label>
        Budgetperioden börjar
        <select value={state.day} disabled={state.saving} onChange={(e) => void choose(Number(e.target.value))}>
          {DAYS.map((d) => (
            <option key={d} value={d}>
              {label(d)}
            </option>
          ))}
        </select>
      </label>
      <small>
        Pågående period: {formatDateShort(state.period.start)} – {formatDateShort(state.period.end)}. Infaller dagen på en helg börjar perioden
        bankdagen före.
      </small>
      {state.message && <p role={state.message === "Sparat." ? "status" : "alert"}>{state.message}</p>}
    </div>
  );
}
