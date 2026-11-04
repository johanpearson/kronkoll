// Ikonknappar (KK-26-E): vanliga åtgärder visas som en ikon utan text, så att mobilen blir luftigare.
// Etiketten finns kvar som aria-label för skärmläsare och som title för den som håller muspekaren
// över. Huvudåtgärder och det som tar bort något har kvar sin text.
import { formatDateShort } from "@kronkoll/domain";
import { ChevronLeft, ChevronRight, type LucideIcon } from "lucide-react";

export function IconButton(props: {
  label: string;
  icon: LucideIcon;
  onClick?: () => void;
  type?: "button" | "submit";
  disabled?: boolean;
  busy?: boolean;
  spin?: boolean;
}) {
  const Icon = props.icon;
  return (
    <button
      type={props.type === "submit" ? "submit" : "button"}
      className="icon-button"
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      aria-busy={props.busy}
      onClick={props.onClick}
    >
      <Icon aria-hidden="true" size={20} strokeWidth={2} className={props.spin ? "spin" : undefined} />
    </button>
  );
}

/** Byt period med pilar på var sida om periodens datum. */
export function PeriodNav(props: { period: { start: string; end: string } | null; onGo: (months: number) => void }) {
  const { period } = props;
  return (
    <p className="period-nav">
      <IconButton label="Föregående period" icon={ChevronLeft} disabled={!period} onClick={() => { props.onGo(-1); }} />
      <span>{period && `${formatDateShort(period.start)} – ${formatDateShort(period.end)}`}</span>
      <IconButton label="Nästa period" icon={ChevronRight} disabled={!period} onClick={() => { props.onGo(1); }} />
    </p>
  );
}
