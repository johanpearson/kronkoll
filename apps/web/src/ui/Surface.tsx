// Kort, tom vy och skelett (KK-65-A): ytorna som vyerna byggs av.
import type { LucideIcon } from "lucide-react";
import { useId, type ReactNode } from "react";

/** Ett kort för en del av en vy, t.ex. Buffert på översikten. Tonar in när det visas (KK-65-B). */
export function Card(props: { title?: string; action?: ReactNode; children: ReactNode }) {
  const titleId = useId();
  const hasTitle = props.title !== undefined;
  return (
    <section className="ui-card ui-enter" aria-labelledby={hasTitle ? titleId : undefined}>
      {hasTitle && (
        <header className="ui-card-header">
          <h2 id={titleId} className="ui-heading">
            {props.title}
          </h2>
          {props.action}
        </header>
      )}
      {props.children}
    </section>
  );
}

/** När en lista är tom: vad det betyder och vad man kan göra. */
export function EmptyState(props: { title: string; icon?: LucideIcon; action?: ReactNode; children?: ReactNode }) {
  const Icon = props.icon;
  return (
    <div className="ui-empty">
      {Icon && (
        <span className="ui-empty-icon">
          <Icon aria-hidden="true" size={28} strokeWidth={1.75} />
        </span>
      )}
      <h2 className="ui-heading">{props.title}</h2>
      {props.children !== undefined && <p className="ui-body">{props.children}</p>}
      {props.action}
    </div>
  );
}

/** Grå rader på innehållets plats medan det laddas, så att sidan inte hoppar när det kommer. */
export function Skeleton(props: { lines?: number }) {
  const lines = Array.from({ length: props.lines ?? 1 }, (_, i) => i);
  return (
    <div className="ui-skeleton">
      <span role="status" className="ui-visually-hidden">
        Laddar…
      </span>
      {lines.map((i) => (
        <span key={i} className="ui-skeleton-line" aria-hidden="true" />
      ))}
    </div>
  );
}
