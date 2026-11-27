// Dra för att synka (KK-63-D). Högst upp på sidan följer en indikator fingret nedåt, och släpps den förbi
// gränsen ber den synkstatusen att synka (KK-64-A visar sedan hur det går). Ett drag uppåt eller i sidled är
// något annat och släpps. Besluten om sträckor tas i gesture.ts.
import { useRef, useState, type PointerEvent } from "react";
import { requestSync } from "../sync/SyncStatus.tsx";
import { pullDistance, pullTriggers, swipeAxis } from "./gesture.ts";

export function usePullToSync(enabled: boolean) {
  const [distance, setDistance] = useState(0);
  const start = useRef<{ x: number; y: number; axis: "x" | "y" | null } | null>(null);
  const current = useRef(0);

  const show = (value: number) => {
    current.current = value;
    setDistance(value);
  };
  const stop = () => {
    start.current = null;
    show(0);
  };

  const handlers = {
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (!enabled || event.pointerType === "mouse" || window.scrollY > 0 || document.querySelector("dialog[open]")) return;
      start.current = { x: event.clientX, y: event.clientY, axis: null };
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const s = start.current;
      if (!s) return;
      const dy = event.clientY - s.y;
      s.axis ??= swipeAxis(event.clientX - s.x, dy);
      if (s.axis === "x" || (s.axis === "y" && dy < 0)) {
        stop();
        return;
      }
      if (s.axis === "y") show(pullDistance(dy));
    },
    onPointerUp: () => {
      if (start.current && pullTriggers(current.current)) requestSync();
      stop();
    },
    onPointerCancel: () => {
      stop();
    },
  };
  return { handlers, distance };
}
