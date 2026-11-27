// Diagram i designsystemet (KK-65-B): staplar, ring och linje i egen SVG, utan bibliotek, så att de
// fungerar med den strikta CSP:n. Varje diagram är en bild med namn för skärmläsare och har en dold
// lista med värdena, eftersom en bild inte går att läsa siffra för siffra.
import { formatSek } from "@kronkoll/domain";
import { barRects, linePoints, ringOffset } from "./geometry.ts";
import { chartTiming, useReveal } from "./reveal.ts";

interface Point {
  readonly label: string;
  readonly valueMinor: number;
}

function Values(props: { label: string; points: readonly Point[] }) {
  return (
    <ul className="ui-visually-hidden" aria-label={props.label}>
      {props.points.map((p) => (
        <li key={p.label}>{`${p.label}: ${formatSek(p.valueMinor)}`}</li>
      ))}
    </ul>
  );
}

const W = 320;
const H = 120;

/** Staplar, t.ex. utgifter per period. Max kan sättas till budgeten så att staplarna jämförs mot den. */
export function BarChart(props: { label: string; bars: readonly Point[]; maxMinor?: number }) {
  const ref = useReveal<SVGSVGElement>((svg) => {
    svg.querySelectorAll("rect").forEach((rect, i) => {
      rect.animate([{ transform: "scaleY(0)" }, { transform: "scaleY(1)" }], chartTiming(i * 30));
    });
  });
  const rects = barRects(
    props.bars.map((b) => b.valueMinor),
    { width: W, height: H, gap: 6, max: props.maxMinor },
  );
  return (
    <figure className="ui-chart">
      <svg ref={ref} className="ui-bars" viewBox={`0 0 ${String(W)} ${String(H)}`} role="img" aria-label={props.label}>
        {rects.map((r, i) => (
          <rect key={props.bars[i]?.label ?? i} x={r.x} y={r.y} width={r.width} height={r.height} rx={4} />
        ))}
      </svg>
      <div className="ui-chart-labels" aria-hidden="true">
        {props.bars.map((b) => (
          <span key={b.label}>{b.label}</span>
        ))}
      </div>
      <Values label={props.label} points={props.bars} />
    </figure>
  );
}

const R = 52;
const C = Math.round(2 * Math.PI * R * 100) / 100;

/** En ring som fylls mot ett mål, t.ex. hur mycket av budgeten som är använd. Röd när målet är passerat. */
export function RingChart(props: { label: string; valueMinor: number; totalMinor: number; center?: string }) {
  const offset = ringOffset(props.valueMinor, props.totalMinor, C);
  const ref = useReveal<SVGSVGElement>((svg) => {
    svg.querySelector(".ui-ring-value")?.animate([{ strokeDashoffset: C }, { strokeDashoffset: offset }], chartTiming());
  });
  const over = props.valueMinor > props.totalMinor;
  return (
    <figure className="ui-chart ui-ring">
      <svg ref={ref} viewBox="0 0 120 120" role="img" aria-label={`${props.label}: ${formatSek(props.valueMinor)} av ${formatSek(props.totalMinor)}`}>
        <circle className="ui-ring-track" cx={60} cy={60} r={R} />
        <circle className={over ? "ui-ring-value ui-ring-over" : "ui-ring-value"} cx={60} cy={60} r={R} strokeDasharray={C} strokeDashoffset={offset} />
      </svg>
      {props.center !== undefined && (
        <span className="ui-ring-center" aria-hidden="true">
          {props.center}
        </span>
      )}
    </figure>
  );
}

/** En linje genom punkterna, t.ex. saldot över tid. Ritas fram från vänster. */
export function LineChart(props: { label: string; points: readonly Point[] }) {
  const ref = useReveal<SVGSVGElement>((svg) => {
    svg.querySelector("polyline")?.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], chartTiming());
  });
  const points = linePoints(
    props.points.map((p) => p.valueMinor),
    { width: W, height: H - 8 },
  );
  return (
    <figure className="ui-chart">
      <svg ref={ref} className="ui-line" viewBox={`0 -4 ${String(W)} ${String(H)}`} role="img" aria-label={props.label}>
        <polyline points={points} pathLength={1} strokeDasharray={1} />
      </svg>
      <Values label={props.label} points={props.points} />
    </figure>
  );
}
