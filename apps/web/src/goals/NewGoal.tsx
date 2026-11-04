// Nytt sparmål (#39, KK-21): namn, målbelopp, måldatum och hur man sparar. Manuella avsättningar kan
// börja med ett belopp som redan är sparat; ett kopplat konto räknar sitt saldo som sparat. API:t kontrollerar
// allt igen, bland annat att måldatum ligger efter i dag, och svarar med prognosen.
import { parseAmount } from "@kronkoll/domain";
import { useEffect, useState, type SyntheticEvent } from "react";
import { field, getJson, postJson } from "../api.ts";
import { navigate } from "../router.tsx";
import { useToast } from "../toast.tsx";

interface Account {
  readonly id: string;
  readonly name: string;
}

/** Kronor som text till öre: null om texten inte är ett belopp. Tomt räknas som 0. */
export function parseKronor(text: string): number | null {
  // \s tar även hårda mellanslag, som Intl använder mellan tusental.
  const normalized = text.replace(/\s/gu, "").replace(",", ".");
  if (normalized === "") return 0;
  try {
    const ore = parseAmount(normalized);
    return ore < 0 ? null : ore;
  } catch {
    return null;
  }
}

async function fetchAccounts(): Promise<Account[]> {
  const { status, body } = await getJson("/api/accounts");
  const items = field(body, "items");
  if (status !== 200 || !Array.isArray(items)) return [];
  return items.flatMap((a) => {
    const id = field(a, "id");
    const name = field(a, "name");
    return typeof id === "string" && typeof name === "string" ? [{ id, name }] : [];
  });
}

const ERRORS: Record<string, string> = {
  target_date_in_past: "Måldatum måste ligga efter i dag.",
  unknown_account: "Kontot finns inte längre. Välj ett annat.",
};

export function NewGoal() {
  const toast = useToast();
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [date, setDate] = useState("");
  const [source, setSource] = useState<"manual" | "account">("manual");
  const [initial, setInitial] = useState("");
  const [accountId, setAccountId] = useState("");
  const [accounts, setAccounts] = useState<readonly Account[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fetchAccounts().then(setAccounts);
  }, []);

  const save = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const targetMinor = parseKronor(target);
    const initialMinor = parseKronor(initial);
    const problem =
      name.trim() === ""
        ? "Ge målet ett namn."
        : targetMinor === null || targetMinor === 0
          ? "Skriv målbeloppet i kronor, till exempel 60 000."
          : source === "manual" && initialMinor === null
            ? "Skriv det som redan är sparat i kronor, eller lämna fältet tomt."
            : source === "account" && accountId === ""
              ? "Välj vilket konto som sparar till målet."
              : null;
    setError(problem);
    if (problem !== null) return;
    setBusy(true);
    const { status, body } = await postJson("/api/goals", {
      name: name.trim(),
      target_minor: targetMinor,
      target_date: date === "" ? null : date,
      source: source === "manual" ? { type: "manual", initial_minor: initialMinor } : { type: "account", account_id: accountId },
    });
    setBusy(false);
    if (status === 201) {
      toast.done("Sparmålet är skapat.");
      navigate("/sparmal");
      return;
    }
    const code = field(body, "error");
    setError((typeof code === "string" ? ERRORS[code] : undefined) ?? "Det gick inte att spara målet. Försök igen.");
  };

  return (
    <main>
      <h1>Nytt sparmål</h1>
      <form className="card goal-form" aria-label="Nytt sparmål" onSubmit={(e) => void save(e)}>
        <label>
          Namn
          <input value={name} maxLength={60} onChange={(e) => { setName(e.target.value); }} />
        </label>
        <label>
          Målbelopp (kr)
          <input value={target} inputMode="decimal" onChange={(e) => { setTarget(e.target.value); }} />
        </label>
        <label>
          Måldatum (valfritt)
          <input type="date" value={date} onChange={(e) => { setDate(e.target.value); }} />
        </label>
        <fieldset className="choices">
          <legend>Hur sparar du?</legend>
          <label>
            <input type="radio" name="source" checked={source === "manual"} onChange={() => { setSource("manual"); }} />
            Egna avsättningar
          </label>
          <label>
            <input type="radio" name="source" checked={source === "account"} disabled={accounts.length === 0} onChange={() => { setSource("account"); }} />
            Ett konto (saldot räknas)
          </label>
        </fieldset>
        {source === "manual" ? (
          <label>
            Redan sparat (kr)
            <input value={initial} inputMode="decimal" placeholder="0" onChange={(e) => { setInitial(e.target.value); }} />
          </label>
        ) : (
          <label>
            Konto
            <select value={accountId} onChange={(e) => { setAccountId(e.target.value); }}>
              <option value="">Välj konto</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {error && <p role="alert">{error}</p>}
        <p className="actions">
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "Sparar…" : "Skapa sparmål"}
          </button>
          <button type="button" onClick={() => { navigate("/sparmal"); }}>
            Avbryt
          </button>
        </p>
      </form>
    </main>
  );
}
