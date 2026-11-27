// Diagram fylls från noll första gången de syns (KK-65-B). De ritas alltid i sitt slutläge, och
// animationen körs ovanpå med Web Animations API. Vid minskad rörelse eller utan stöd står de bara där.
import { useEffect, useRef } from "react";
import { EASING, prefersReducedMotion } from "../../design/motion.ts";

/** Diagrammen får ta lite längre tid än vyernas övergångar, men ska kännas lugna, inte långsamma. */
export const CHART_MS = 500;

export const chartTiming = (delay = 0): KeyframeAnimationOptions => ({ duration: CHART_MS, easing: EASING.out, delay, fill: "backwards" });

/** Kör run(element) en gång när elementet först syns. */
export function useReveal<T extends Element>(run: (element: T) => void) {
  const ref = useRef<T>(null);
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  });
  useEffect(() => {
    const element = ref.current;
    if (!element || prefersReducedMotion() || typeof element.animate !== "function") return;
    if (typeof window.IntersectionObserver !== "function") {
      runRef.current(element);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      observer.disconnect();
      runRef.current(element);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);
  return ref;
}
