// Rörelse i designsystemet (KK-65-B). Tiderna är desamma som i tokens.css, så att animationer i CSS och
// med Web Animations API rör sig lika. Vid minskad rörelse (KK-26-B) animeras ingenting.
export const MOTION = { fast: 120, base: 200, slow: 250 } as const;

export const EASING = {
  standard: "cubic-bezier(0.2, 0, 0, 1)",
  /** Bromsar in mot slutet: för det som kommer in på skärmen. */
  out: "cubic-bezier(0.05, 0.7, 0.1, 1)",
} as const;

export function prefersReducedMotion(): boolean {
  if (typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Tonar in och glider upp ett element, t.ex. en vy eller ett kort som just visats. */
export function enter(element: Element | null): Animation | null {
  if (!element || typeof element.animate !== "function" || prefersReducedMotion()) return null;
  return element.animate(
    [
      { opacity: 0, transform: "translateY(8px)" },
      { opacity: 1, transform: "none" },
    ],
    { duration: MOTION.slow, easing: EASING.out, fill: "backwards" },
  );
}
