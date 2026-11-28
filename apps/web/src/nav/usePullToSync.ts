// Dra för att synka (KK-63-D). Högst upp på sidan följer en indikator fingret nedåt, och släpps den förbi
// gränsen ber den synkstatusen att synka (KK-64-A visar sedan hur det går). Ett drag uppåt eller i sidled är
// något annat och lämnas åt webbläsaren. Besluten om sträckor tas i gesture.ts.
// Pekarhändelser räcker inte här: med touch-action: pan-y tar webbläsaren över varje lodrätt drag och skickar
// pointercancel. Därför lyssnar hooken på touch-händelser med en icke-passiv lyssnare och stoppar webbläsarens
// egen scrollning så länge fingret drar nedåt högst upp på sidan (#247).
import { useEffect, useState } from "react";
import { requestSync } from "../sync/SyncStatus.tsx";
import { pullDistance, pullTriggers, swipeAxis } from "./gesture.ts";

export function usePullToSync(enabled: boolean) {
  const [distance, setDistance] = useState(0);
  const [element, setElement] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!element || !enabled) return;
    let start: { x: number; y: number; axis: "x" | "y" | null } | null = null;
    let current = 0;
    const show = (value: number) => {
      current = value;
      setDistance(value);
    };
    const stop = () => {
      start = null;
      show(0);
    };

    const onStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      start = event.touches.length === 1 && touch && window.scrollY <= 0 && !document.querySelector("dialog[open]") ? { x: touch.clientX, y: touch.clientY, axis: null } : null;
    };
    const onMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!start || !touch) return;
      const dy = touch.clientY - start.y;
      start.axis ??= swipeAxis(touch.clientX - start.x, dy);
      if (start.axis === "x" || dy < 0) {
        stop();
        return;
      }
      // Fingret drar nedåt högst upp: appen tar hand om det, inte webbläsarens scrollning eller omladdning.
      if (event.cancelable) event.preventDefault();
      if (start.axis === "y") show(pullDistance(dy));
    };
    const onEnd = () => {
      if (start && pullTriggers(current)) requestSync();
      stop();
    };

    element.addEventListener("touchstart", onStart, { passive: true });
    element.addEventListener("touchmove", onMove, { passive: false });
    element.addEventListener("touchend", onEnd);
    element.addEventListener("touchcancel", stop);
    return () => {
      element.removeEventListener("touchstart", onStart);
      element.removeEventListener("touchmove", onMove);
      element.removeEventListener("touchend", onEnd);
      element.removeEventListener("touchcancel", stop);
    };
  }, [element, enabled]);

  return { ref: setElement, distance };
}
