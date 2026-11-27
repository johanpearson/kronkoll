// Inmatning för belopp (KK-65-A): kronor med decimaltangentbord på mobilen. Fältet håller texten som
// användaren skrev, och vyn tolkar den med parseKronor när den sparar. Fel visas vid fältet och kopplas
// till det, så att skärmläsare läser upp dem.
import { useId } from "react";
import { parseKronor } from "../kronor.ts";

export function AmountInput(props: { label: string; value: string; onChange: (text: string) => void; hint?: string }) {
  const id = useId();
  const invalid = parseKronor(props.value) === null;
  const noteId = `${id}-note`;
  const note = invalid ? "Skriv ett belopp i kronor, t.ex. 1 250,50." : props.hint;
  return (
    <div className="ui-field">
      <label htmlFor={id} className="ui-label">
        {props.label}
      </label>
      <div className="ui-amount-input">
        <input
          id={id}
          inputMode="decimal"
          autoComplete="off"
          value={props.value}
          aria-invalid={invalid || undefined}
          aria-describedby={note === undefined ? undefined : noteId}
          onChange={(event) => {
            props.onChange(event.target.value);
          }}
        />
        <span aria-hidden="true">kr</span>
      </div>
      {note !== undefined && (
        <p id={noteId} className={invalid ? "ui-field-error" : "ui-caption"}>
          {note}
        </p>
      )}
    </div>
  );
}
