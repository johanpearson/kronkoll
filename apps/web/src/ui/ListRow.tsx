// Listrader (KK-65-A): ikon, text med detalj under, värde till höger och chevron när raden går att trycka
// på. En rad som gör något är en knapp och en rad som leder till en annan sida är en länk, båda över
// hela raden med minst 44 px höjd. Text från banken skickas in som vanlig text (KK-30).
import { ChevronRight, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "../router.tsx";

export function List(props: { label?: string; children: ReactNode }) {
  return (
    <ul className="ui-list" aria-label={props.label}>
      {props.children}
    </ul>
  );
}

interface RowProps {
  label: ReactNode;
  detail?: ReactNode;
  value?: ReactNode;
  icon?: LucideIcon;
  danger?: boolean;
  onClick?: () => void;
  /** Sidan som raden leder till. */
  to?: string;
}

export function ListRow(props: RowProps) {
  const Icon = props.icon;
  const pressable = props.onClick !== undefined || props.to !== undefined;
  const content = (
    <>
      {Icon && (
        <span className="ui-row-icon">
          <Icon aria-hidden="true" size={20} strokeWidth={2} />
        </span>
      )}
      <span className="ui-row-text">
        <span className="ui-row-label">{props.label}</span>
        {props.detail !== undefined && <span className="ui-row-detail">{props.detail}</span>}
      </span>
      {props.value !== undefined && <span className="ui-row-value ui-amount">{props.value}</span>}
      {pressable && !props.danger && <ChevronRight className="ui-row-chevron" aria-hidden="true" size={18} strokeWidth={2} />}
    </>
  );
  const className = props.danger ? "ui-row ui-row-danger" : "ui-row";
  let row: ReactNode;
  if (props.to !== undefined) {
    row = (
      <Link to={props.to} className={className}>
        {content}
      </Link>
    );
  } else if (props.onClick) {
    row = (
      <button type="button" className={className} onClick={props.onClick}>
        {content}
      </button>
    );
  } else {
    row = <div className={className}>{content}</div>;
  }
  return <li>{row}</li>;
}
