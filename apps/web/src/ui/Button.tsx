// Knappar i designsystemet (KK-65-A, KK-26-E). Alla åtgärder är <button> med minst 44 px träffyta, aldrig
// en länk i löptext. Primär för vyns huvudåtgärd, sekundär för övriga, tyst för det som inte ska ta
// uppmärksamhet och fara för det som tar bort något.
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

type Variant = "primary" | "secondary" | "quiet" | "danger";

interface Common {
  onClick?: () => void;
  type?: "button" | "submit";
  disabled?: boolean;
  /** Något pågår: knappen är låst och säger det till skärmläsare. */
  busy?: boolean;
}

export function Button(props: Common & { variant?: Variant; icon?: LucideIcon; block?: boolean; children: ReactNode }) {
  const Icon = props.icon;
  const classes = ["ui-button", `ui-button-${props.variant ?? "secondary"}`];
  if (props.block) classes.push("ui-button-block");
  return (
    <button
      type={props.type === "submit" ? "submit" : "button"}
      className={classes.join(" ")}
      disabled={props.disabled === true || props.busy === true}
      aria-busy={props.busy}
      onClick={props.onClick}
    >
      {Icon && <Icon aria-hidden="true" size={18} strokeWidth={2} />}
      {props.children}
    </button>
  );
}

/** En åtgärd som bara visas som ikon. Etiketten blir namn för skärmläsare och tooltip. */
export function IconButton(props: Common & { label: string; icon: LucideIcon; danger?: boolean }) {
  const Icon = props.icon;
  return (
    <button
      type={props.type === "submit" ? "submit" : "button"}
      className={props.danger ? "ui-icon-button ui-icon-button-danger" : "ui-icon-button"}
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled === true || props.busy === true}
      aria-busy={props.busy}
      onClick={props.onClick}
    >
      <Icon aria-hidden="true" size={20} strokeWidth={2} />
    </button>
  );
}
