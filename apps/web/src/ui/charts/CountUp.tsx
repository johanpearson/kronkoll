// Ett belopp som räknas upp från noll när det visas (KK-65-B). Skärmläsare får slutvärdet direkt, och
// vid minskad rörelse visas det som det är.
import { formatSek } from "@kronkoll/domain";
import { useEffect, useState } from "react";
import { prefersReducedMotion } from "../../design/motion.ts";
import { CHART_MS } from "./reveal.ts";

export function CountUp(props: { valueMinor: number; className?: string }) {
  const target = props.valueMinor;
  const [shown, setShown] = useState(() => (prefersReducedMotion() ? target : 0));
  useEffect(() => {
    if (prefersReducedMotion()) {
      setShown(target);
      return;
    }
    let frame = 0;
    let start: number | null = null;
    const tick = (now: number) => {
      start ??= now;
      const t = Math.min((now - start) / CHART_MS, 1);
      // Bromsar in mot slutet, som övriga animationer.
      setShown(Math.round(target * (1 - (1 - t) ** 3)));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [target]);
  return (
    <span className={props.className ?? "ui-amount"}>
      <span aria-hidden="true">{formatSek(shown)}</span>
      <span className="ui-visually-hidden">{formatSek(target)}</span>
    </span>
  );
}
