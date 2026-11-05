// Notiser via Web Push (KK-27, D-notify): reglage för samtycke som går ut, budget överskriden och synk som
// misslyckas. Valen gäller den här enheten. Första valet ber webbläsaren om lov; inga val kvar tar bort
// prenumerationen. Bannern i appen visar samma sak oavsett (R-5).
import { useEffect, useState } from "react";
import { deleteWithBody, field, getJson, postJson } from "../api.ts";
import { pushDevice, storedTopics, type PushDevice } from "./push-device.ts";

const TOPICS = [
  { value: "consent", label: "Samtycket går snart ut (14, 3 och 0 dagar före)" },
  { value: "budget_over", label: "Budget överskriden" },
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
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let current = true;
    void load(device)
      .catch((): State => ({ kind: "off", text: `Den här webbläsaren kan inte ta emot notiser. ${IOS_HINT}` }))
      .then((next) => {
        if (current) setState(next);
      });
    return () => {
      current = false;
    };
  }, [device]);

  if (state.kind === "loading") return <p>Hämtar…</p>;
  if (state.kind === "off") return <p>{state.text}</p>;

  const toggle = async (topic: string, on: boolean) => {
    const topics = TOPICS.map((t) => t.value).filter((t) => (t === topic ? on : state.topics.includes(t)));
    setState({ ...state, saving: true, message: null, failed: false });
    const error = await save(device, state.publicKey, topics).catch(() => "Det gick inte att spara. Försök igen.");
    if (error === null) storedTopics.set(topics);
    setState({ ...state, topics: error === null ? topics : state.topics, saving: false, message: error ?? "Sparat.", failed: error !== null });
  };

  return (
    <fieldset className="choices" disabled={state.saving}>
      <legend>Skicka en notis till den här enheten när</legend>
      {TOPICS.map((t) => (
        <label key={t.value}>
          <input type="checkbox" checked={state.topics.includes(t.value)} onChange={(e) => void toggle(t.value, e.target.checked)} />
          {t.label}
        </label>
      ))}
      <small>Notiserna innehåller aldrig belopp. {IOS_HINT}</small>
      {state.message && <p role={state.failed ? "alert" : "status"}>{state.message}</p>}
    </fieldset>
  );
}
