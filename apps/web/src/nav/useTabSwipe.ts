// Svep mellan flikar (KK-63-A, B, C, F). Vyn följer fingret i sidled och snäpper till nästa eller föregående
// flik, eller studsar tillbaka. Besluten tas i gesture.ts. Svepet byter flik som menyn gör, utan nytt steg i
// historiken. Det startar inte i undervyer, i ett öppet ark, i formulär, på det som själv scrollar i sidled
// eller nära skärmkanten. Vid minskad rörelse följer vyn inte fingret, men svepet byter ändå flik.
import { useRef, type PointerEvent } from "react";
import { prefersReducedMotion } from "../design/motion.ts";
import { navigate } from "../router.tsx";
import { neighbourTab, swipeAxis, swipeDecision } from "./gesture.ts";

/** Element där ett svep i sidled betyder något annat. */
const OWN_GESTURE = "input, textarea, select, [role=slider], [role=radiogroup], [data-no-swipe]";

function scrollsSideways(element: Element | null, stop: Element): boolean {
  for (let node = element; node && node !== stop; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowX;
    if ((overflow === "auto" || overflow === "scroll") && node.scrollWidth > node.clientWidth) return true;
  }
  return false;
}

interface Start {
  readonly x: number;
  readonly y: number;
  readonly time: number;
  axis: "x" | "y" | null;
}

export function useTabSwipe(enabled: boolean) {
  const start = useRef<Start | null>(null);

  const reset = (element: HTMLElement, animate: boolean) => {
    start.current = null;
    element.style.transition = animate && !prefersReducedMotion() ? "transform var(--duration) var(--easing-out)" : "";
    element.style.transform = "";
  };

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    const target = event.target as Element;
    if (!enabled || event.pointerType === "mouse" || document.querySelector("dialog[open]")) return;
    if (target.closest(OWN_GESTURE) || scrollsSideways(target, event.currentTarget)) return;
    start.current = { x: event.clientX, y: event.clientY, time: Date.now(), axis: null };
  };

  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const s = start.current;
    if (!s) return;
    const dx = event.clientX - s.x;
    s.axis ??= swipeAxis(dx, event.clientY - s.y);
    if (s.axis === "y") {
      start.current = null;
      return;
    }
    if (s.axis === "x" && !prefersReducedMotion()) {
      event.currentTarget.style.transition = "none";
      event.currentTarget.style.transform = `translateX(${String(dx)}px)`;
    }
  };

  const onPointerUp = (event: PointerEvent<HTMLElement>) => {
    const s = start.current;
    if (s?.axis !== "x") {
      start.current = null;
      return;
    }
    const direction = swipeDecision({ dx: event.clientX - s.x, ms: Date.now() - s.time, startX: s.x, width: window.innerWidth });
    const tab = direction === null ? null : neighbourTab(window.location.pathname, direction);
    reset(event.currentTarget, tab === null);
    if (tab !== null) navigate(tab, "tab");
  };

  const onPointerCancel = (event: PointerEvent<HTMLElement>) => {
    if (start.current) reset(event.currentTarget, true);
  };

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel };
}
