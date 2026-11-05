// Notiser via Web Push (KK-27, D-notify): ett reglage per typ (samtycke som går ut, budget överskriden och
// synk som misslyckas) och Spara. Reglagen ändrar bara formuläret; först Spara ber webbläsaren om lov och
// skickar valen. Valen gäller den här enheten, och inga val kvar tar bort prenumerationen. Bannern i
// appen visar samma sak oavsett (R-5).
import { useEffect, useState, type SyntheticEvent } from "react";
import { deleteWithBody, field, getJson, postJson } from "../api.ts";
import { useToast } from "../toast.tsx";
import { pushDevice, storedTopics, type PushDevice } from "./push-device.ts";

const TOPICS = [
  { value: "consent", label: "Samtycket hos banken går snart ut" },
  { value: "budget_over", label: "En budget är överskriden" },
  { value: "sync_failed", label: "Synken misslyckas flera gånger i rad" },
] as const;

const IOS_HINT = "På iPhone krävs att Kronkoll är installerad på hemskärmen (iOS 16.4 eller senare).";

type State =
  | { readonly kind: "loading" }
  | { readonly kind: "off"; readonly text: string }
  | { readonly kind: "ready"; readonly publicKey: string; readonly topics: readonly string[]; readonly saving: boolean; readonly message: string | null; readonly failed: boolean };

async function load(device: PushDevice): Promise<State> {
  const { status, body } = await getJson("/api/push");
  const publicKey = field(body, "public_key");
  if (status !== 200) return { kind: "off", text: "Det gick inte att hämta inställningen för notiser." };
  if (field(body, "configured") !== true || typeof publicKey !== "string") return { kind: "off", text: "Notiser är inte påslagna på servern än." };
  if (!(await device.available())) return { kind: "off", text: `Den här webbläsaren kan inte ta emot notiser. ${IOS_HINT}` };
  const subscribed = (await device.current()) !== null;
  const topics = subscribed ? (storedTopics.get() ?? TOPICS.map((t) => t.value)) : [];
  return { kind: "ready", publicKey, topics, saving: false, message: null, failed: false };
}

/** Sparar valen: prenumererar vid behov och skickar typerna, eller tar bort prenumerationen. Ger ett fel att visa, eller null. */
async function save(device: PushDevice, publicKey: string, topics: readonly string[]): Promise<string | null> {
  if (topics.length === 0) {
    const endpoint = await device.unsubscribe();
    if (endpoint !== null) await deleteWithBody("/api/push/subscriptions", { endpoint });
    return null;
  }
  const subscription = (await device.current()) ?? (await device.subscribe(publicKey));
  if (subscription === "denied") return "Notiser är blockerade för Kronkoll. Tillåt dem i webbläsarens inställningar och försök igen.";
  const { status } = await postJson("/api/push/subscriptions", { ...subscription, topics });
  return status === 201 ? null : "Det gick inte att spara. Försök igen.";
}

export function Notifications({ device = pushDevice }: { readonly device?: PushDevice }) {
  const toast = useToast();
  const [state, setState] = useState<State>({ kind: "loading" });
  /** Reglagens läge. Ändras fritt och skickas först med Spara. */
  const [chosen, setChosen] = useState<readonly string[]>([]);

  useEffect(() => {
    let current = true;
    void load(device)
      .catch((): State => ({ kind: "off", text: `Den här webbläsaren kan inte ta emot notiser. ${IOS_HINT}` }))
      .then((next) => {
        if (!current) return;
        setState(next);
        if (next.kind === "ready") setChosen(next.topics);
      });
    return () => {
      current = false;
    };
  }, [device]);

  if (state.kind === "loading") return <p>Hämtar…</p>;
  if (state.kind === "off") return <p>{state.text}</p>;

  const ordered = (topics: readonly string[]) => TOPICS.map((t) => t.value).filter((t) => topics.includes(t));
  const changed = ordered(chosen).join() !== ordered(state.topics).join();
  const flip = (topic: string, on: boolean) => {
    setChosen(on ? [...chosen, topic] : chosen.filter((t) => t !== topic));
    if (state.failed) setState({ ...state, message: null, failed: false });
  };

  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const topics = ordered(chosen);
    setState({ ...state, saving: true, message: null, failed: false });
    const error = await save(device, state.publicKey, topics).catch(() => "Det gick inte att spara. Försök igen.");
    if (error === null) {
      storedTopics.set(topics);
      toast.done(topics.length === 0 ? "Notiserna är avstängda på den här enheten." : "Notiserna är sparade.");
    }
    setState({ ...state, topics: error === null ? topics : state.topics, saving: false, message: error, failed: error !== null });
  };

  const on = state.topics.length > 0;
  return (
    <form className="notify-form" aria-label="Notiser" onSubmit={(e) => void submit(e)}>
      <p className={on ? "notify-status on" : "notify-status"}>{on ? "Notiser är på för den här enheten." : "Notiser är av för den här enheten."}</p>
      <ul className="switch-list">
        {TOPICS.map((t) => (
          <li key={t.value}>
            <label>
              <span>{t.label}</span>
              <input
                type="checkbox"
                role="switch"
                className="switch"
                checked={chosen.includes(t.value)}
                disabled={state.saving}
                onChange={(e) => { flip(t.value, e.target.checked); }}
              />
            </label>
          </li>
        ))}
      </ul>
      {state.message && <p role="alert">{state.message}</p>}
      <p className="actions">
        <button type="submit" className="primary" disabled={!changed || state.saving}>
          {state.saving ? "Sparar…" : "Spara"}
        </button>
        {changed && !state.saving && (
          <button type="button" onClick={() => { setChosen(state.topics); }}>
            Ångra
          </button>
        )}
      </p>
      <small>Notiserna innehåller aldrig belopp. {IOS_HINT}</small>
    </form>
  );
}
