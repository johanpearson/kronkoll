// Kontrollerar att färgtokens klarar WCAG AA i både ljust och mörkt läge (KK-26-A). Läser tokens.css
// direkt, så att en ändrad färg som blir svårläst stoppas i CI.
import { describe, expect, it } from "vitest";
import css from "./tokens.css?raw";

/** Färgerna i ett block, t.ex. `:root { … }`, som namn → #rrggbb. */
function tokens(selector: string): Map<string, string> {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`${selector} saknas i tokens.css`);
  const block = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  return new Map([...block.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})\s*;/gu)].map((m) => [m[1] ?? "", (m[2] ?? "").toLowerCase()]));
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

/** Text och ikoner som måste gå att läsa mot sin bakgrund: 4,5:1 för text, 3:1 för kanter och fokus. */
const PAIRS: [string, string, number][] = [
  ["text", "background", 4.5],
  ["text", "surface", 4.5],
  ["heading", "background", 4.5],
  ["muted", "background", 4.5],
  ["muted", "surface", 4.5],
  ["primary", "surface", 4.5],
  ["primary", "background", 4.5],
  ["on-primary", "primary", 4.5],
  ["success", "surface", 4.5],
  ["warning", "surface", 4.5],
  ["danger", "surface", 4.5],
  ["info", "surface", 4.5],
  ["focus", "background", 3],
  ["border-strong", "surface", 3],
];

const THEMES = [
  ["ljust", ":root {"],
  ["mörkt", ':root[data-theme="dark"] {'],
] as const;

describe("färger som går att läsa (KK-26-A, WCAG AA)", () => {
  for (const [name, selector] of THEMES) {
    describe(`${name} läge`, () => {
      const colors = tokens(selector);
      it.each(PAIRS)("%s mot %s har minst %d:1", (fg, bg, min) => {
        const a = colors.get(fg);
        const b = colors.get(bg);
        expect(a, `--${fg} saknas`).toBeDefined();
        expect(b, `--${bg} saknas`).toBeDefined();
        expect(contrast(a ?? "", b ?? "")).toBeGreaterThanOrEqual(min);
      });
    });
  }

  it("det mörka läget följer också systemet när användaren inte valt, med exakt samma färger", () => {
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect([...tokens(':root:not([data-theme="light"]) {')]).toEqual([...tokens(':root[data-theme="dark"] {')]);
  });
});
