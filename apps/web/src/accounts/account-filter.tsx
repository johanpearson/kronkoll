// Kontofilter för Transaktioner, Budget och Insikter (KK-41-C). Bara konton som räknas med kan väljas. Utan
// val visas alla konton, och ett aktivt filter står alltid med text, inte bara som markering. Kontonamnet är
// användarens text och renderas som text (KK-37-C).
import { useEffect, useState } from "react";
import { field, getJson } from "../api.ts";

export interface AccountChoice {
  readonly id: string;
  readonly name: string;
}

/** `account=acc_1&account=acc_2`, tomt utan konton. */
export function accountParams(ids: readonly string[]): string {
  return ids.map((id) => `account=${encodeURIComponent(id)}`).join("&");
}

/** Kontona som räknas med. Tomt medan de hämtas och om det går fel, så att filtret då inte visas. */
export function useAccountChoices(): readonly AccountChoice[] {
  const [choices, setChoices] = useState<readonly AccountChoice[]>([]);
  useEffect(() => {
    let current = true;
    void getJson("/api/accounts").then(({ status, body }) => {
      const items = field(body, "items");
      if (!current || status !== 200 || !Array.isArray(items)) return;
      setChoices(
        items.flatMap((raw): AccountChoice[] => {
          const id = field(raw, "id");
          const name = field(raw, "name");
          // Ett uteslutet konto (KK-53) går inte att välja.
          return typeof id === "string" && typeof name === "string" && field(raw, "role") !== "excluded" ? [{ id, name }] : [];
        }),
      );
    });
    return () => {
      current = false;
    };
  }, []);
  return choices;
}

function list(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} och ${names.at(-1) ?? ""}`;
}

export function AccountFilter(props: { choices: readonly AccountChoice[]; selected: readonly string[]; onChange: (selected: string[]) => void }) {
  const { choices, selected } = props;
  // Med ett enda konto finns inget att välja mellan.
  if (choices.length < 2) return null;
  const toggle = (id: string) => {
    props.onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  };
  const names = choices.filter((c) => selected.includes(c.id)).map((c) => c.name);
  return (
    <fieldset className="account-filter" aria-label="Konton">
      <legend>Konton</legend>
      <p className="actions">
        {choices.map((c) => (
          <button key={c.id} type="button" className="small" aria-pressed={selected.includes(c.id)} onClick={() => { toggle(c.id); }}>
            {c.name}
          </button>
        ))}
      </p>
      {names.length > 0 && (
        <p className="note" role="note">
          Visar bara {list(names)}{" "}
          <button type="button" className="small" onClick={() => { props.onChange([]); }}>
            Visa alla konton
          </button>
        </p>
      )}
    </fieldset>
  );
}
