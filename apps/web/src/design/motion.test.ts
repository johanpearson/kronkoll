// @vitest-environment jsdom
// Rörelse i designsystemet (KK-65-B, KK-26-B): korta tider som stämmer med tokens.css, och ingen
// animation alls för den som valt minskad rörelse.
import { afterEach, describe, expect, it, vi } from "vitest";
import css from "../styles/tokens.css?raw";
import { EASING, MOTION, enter, prefersReducedMotion } from "./motion.ts";

const token = (name: string) => css.match(new RegExp(`--${name}:\\s*([^;]+);`, "u"))?.[1]?.trim();

function mockMotion(reduce: boolean) {
  window.matchMedia = vi.fn((query: string) => ({ matches: reduce && query === "(prefers-reduced-motion: reduce)" }) as MediaQueryList);
}

afterEach(() => {
  vi.restoreAllMocks();
  // @ts-expect-error jsdom saknar matchMedia, och testerna lägger till den själva.
  delete window.matchMedia;
});

describe("tider och kurvor (KK-65-B)", () => {
  it("är desamma som i tokens.css, så att CSS och skript rör sig lika", () => {
    expect(token("duration-fast")).toBe(`${String(MOTION.fast)}ms`);
    expect(token("duration")).toBe(`${String(MOTION.base)}ms`);
    expect(token("duration-slow")).toBe(`${String(MOTION.slow)}ms`);
    expect(token("easing")).toBe(EASING.standard);
    expect(token("easing-out")).toBe(EASING.out);
  });

  it("är korta: högst 250 ms", () => {
    expect(Math.max(...Object.values(MOTION))).toBeLessThanOrEqual(250);
    expect(MOTION.fast).toBeLessThan(MOTION.base);
    expect(MOTION.base).toBeLessThan(MOTION.slow);
  });
});

describe("prefersReducedMotion (KK-26-B)", () => {
  it("följer systemets inställning", () => {
    mockMotion(true);
    expect(prefersReducedMotion()).toBe(true);
    mockMotion(false);
    expect(prefersReducedMotion()).toBe(false);
  });

  it("räknar med vanlig rörelse när webbläsaren inte kan svara", () => {
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe("enter", () => {
  it("tonar in och glider upp med den långsamma tiden", () => {
    mockMotion(false);
    const element = document.createElement("div");
    const animation = {} as Animation;
    const animate = vi.fn(() => animation);
    element.animate = animate;
    expect(enter(element)).toBe(animation);
    expect(animate).toHaveBeenCalledWith(
      [
        { opacity: 0, transform: "translateY(8px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: MOTION.slow, easing: EASING.out, fill: "backwards" },
    );
  });

  it("gör ingenting vid minskad rörelse", () => {
    mockMotion(true);
    const element = document.createElement("div");
    const animate = vi.fn();
    element.animate = animate;
    expect(enter(element)).toBeNull();
    expect(animate).not.toHaveBeenCalled();
  });

  it("gör ingenting utan element eller utan Web Animations", () => {
    mockMotion(false);
    expect(enter(null)).toBeNull();
    const element = document.createElement("div");
    // @ts-expect-error äldre webbläsare saknar animate.
    element.animate = undefined;
    expect(enter(element)).toBeNull();
  });
});
