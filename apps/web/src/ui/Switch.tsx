// Brytare (KK-65-A): av eller på för en inställning som gäller direkt, t.ex. notiser. En <button> med
// rollen switch, så att skärmläsare säger både namnet och läget.
import type { ReactNode } from "react";

export function Switch(props: { checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      role="switch"
      className="ui-switch"
      aria-checked={props.checked}
      disabled={props.disabled}
      onClick={() => {
        props.onChange(!props.checked);
      }}
    >
      <span className="ui-switch-label">{props.children}</span>
      <span className="ui-switch-track" aria-hidden="true">
        <span className="ui-switch-thumb" />
      </span>
    </button>
  );
}
