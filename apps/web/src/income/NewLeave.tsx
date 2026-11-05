// Planera föräldraledighet (#40, KK-23): period, uttag per vecka, årsinkomst för SGI, föräldralön och
// skattesats. Ett manuellt belopp används i stället för uppskattningen (KK-23-B). Uppskattningen räknas
// i API:t och visas på Inkomst när perioden är sparad.
import { useState, type SyntheticEvent } from "react";
import { field, postJson } from "../api.ts";
import { parseKronor } from "../goals/NewGoal.tsx";
import { navigate } from "../router.tsx";
import { useToast } from "../toast.tsx";

const DAYS = [
  { value: 7, label: "7 dagar/vecka (heltid)" },
  { value: 5, label: "5 dagar/vecka" },
  { value: 3, label: "3 dagar/vecka" },
  { value: 2.5, label: "2,5 dagar/vecka (halvtid)" },
];

/** Procent med decimalkomma, 0–100. Null om texten inte är en procentsats. */
export function parsePercent(text: string): number | null {
  const normalized = text.trim().replace(",", ".");
  if (!/^\d{1,3}(\.\d{1,2})?$/u.test(normalized)) return null;
  const value = Number(normalized);
  return value <= 100 ? value : null;
}

const ERRORS: Record<string, string> = {
  to_before_from: "Slutdatum måste vara samma dag som eller efter startdatum.",
  period_too_long: "Planera högst två år i taget. Dela upp längre ledighet i flera perioder.",
};

export function NewLeave() {
  const toast = useToast();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [days, setDays] = useState(5);
  const [sgi, setSgi] = useState("");
  const [topup, setTopup] = useState("0");
  const [tax, setTax] = useState("");
  const [manual, setManual] = useState(false);
  const [override, setOverride] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const sgiMinor = parseKronor(sgi);
    const topupPct = parsePercent(topup);
    const taxPct = parsePercent(tax);
    const overrideMinor = parseKronor(override);
    const problem =
      from === "" || to === ""
        ? "Välj start- och slutdatum."
        : sgiMinor === null || sgiMinor === 0
          ? "Skriv årsinkomsten för SGI i kronor, till exempel 540 000."
          : topupPct === null
            ? "Skriv föräldralönen i procent, 0–100. Skriv 0 om du inte får någon."
            : taxPct === null
              ? "Skriv skattesatsen i procent, till exempel 31,5."
              : manual && (overrideMinor === null || overrideMinor === 0)
                ? "Skriv det manuella beloppet i kronor per månad."
                : null;
    setError(problem);
    if (problem !== null) return;
    setBusy(true);
    const { status, body } = await postJson("/api/leave-periods", {
      from,
      to,
      days_per_week: days,
      sgi_annual_minor: sgiMinor,
      employer_topup_pct: topupPct,
      tax_rate_pct: taxPct,
      override_net_monthly_minor: manual ? overrideMinor : null,
    });
    setBusy(false);
    if (status === 201) {
      toast.done("Ledigheten är planerad.");
      navigate("/inkomst");
      return;
    }
    const code = field(body, "error");
    setError((typeof code === "string" ? ERRORS[code] : undefined) ?? "Det gick inte att spara. Försök igen.");
  };

  return (
    <main>
      <h1>Planera föräldraledighet</h1>
      <form className="card goal-form" aria-label="Planera föräldraledighet" onSubmit={(e) => void save(e)}>
        <label>
          Från
          <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); }} />
        </label>
        <label>
          Till
          <input type="date" value={to} onChange={(e) => { setTo(e.target.value); }} />
        </label>
        <label>
          Uttag
          <select value={days} onChange={(e) => { setDays(Number(e.target.value)); }}>
            {DAYS.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Årsinkomst för SGI (kr)
          <input value={sgi} inputMode="decimal" aria-describedby="sgi-hint" onChange={(e) => { setSgi(e.target.value); }} />
        </label>
        <small id="sgi-hint">Står på Mina sidor hos Försäkringskassan. Över taket räknas bara taket.</small>
        <label>
          Föräldralön (% av lön)
          <input value={topup} inputMode="decimal" onChange={(e) => { setTopup(e.target.value); }} />
        </label>
        <label>
          Skattesats (%)
          <input value={tax} inputMode="decimal" aria-describedby="tax-hint" onChange={(e) => { setTax(e.target.value); }} />
        </label>
        <small id="tax-hint">Står på lönebeskedet eller skattsedeln.</small>
        <label className="check">
          <input type="checkbox" checked={manual} onChange={(e) => { setManual(e.target.checked); }} />
          Ange belopp manuellt
        </label>
        {manual && (
          <label>
            Manuellt netto per månad (kr)
            <input value={override} inputMode="decimal" onChange={(e) => { setOverride(e.target.value); }} />
          </label>
        )}
        <p className="note" role="note">
          Uppskattning – inte ett besked från Försäkringskassan.{manual ? " Det manuella beloppet används i stället för uppskattningen." : ""}
        </p>
        {error && <p role="alert">{error}</p>}
        <p className="actions">
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "Sparar…" : "Spara"}
          </button>
          <button type="button" onClick={() => { navigate("/inkomst"); }}>
            Avbryt
          </button>
        </p>
      </form>
    </main>
  );
}
