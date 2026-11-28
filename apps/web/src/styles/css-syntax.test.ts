// CSS-filerna är hela (#247): en klammer som saknas gör att resten av filen tolkas som nästlad under
// föregående regel, och då slutar t.ex. touch-action för svepen att gälla utan att något annat syns.
// Det hände efter en konfliktlösning, så varje fil kontrolleras här.
import { describe, expect, it } from "vitest";
import base from "./base.css?raw";
import components from "./components.css?raw";
import tokens from "./tokens.css?raw";
import ui from "./ui.css?raw";

/** Djupet efter varje regel: 0 utanför allt, 1 i en regel eller @media, 2 i en regel i @media. */
function problems(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  const found: string[] = [];
  let depth = 0;
  let atRule = false;
  let selector = "";
  for (const char of text) {
    if (char === "{") {
      if (depth === 1 && !atRule) found.push(`nästlad regel: ${selector.trim()}`);
      if (depth === 0) atRule = selector.trim().startsWith("@");
      depth += 1;
      selector = "";
    } else if (char === "}") {
      depth -= 1;
      if (depth < 0) found.push("en } för mycket");
      selector = "";
    } else if (char === ";") {
      selector = "";
    } else {
      selector += char;
    }
  }
  if (depth > 0) found.push(`${String(depth)} { saknar sin }`);
  return found;
}

describe("CSS-filerna är hela", () => {
  it.each([
    ["base.css", base],
    ["components.css", components],
    ["tokens.css", tokens],
    ["ui.css", ui],
  ])("%s har balanserade klamrar och inga nästlade regler", (_, css) => {
    expect(css.length).toBeGreaterThan(100);
    expect(problems(css)).toEqual([]);
  });

  it("upptäcker en regel som saknar sin }", () => {
    expect(problems(".a {\n  color: red;\n\n.b {\n  color: blue;\n}\n")).toEqual(["nästlad regel: .b", "1 { saknar sin }"]);
    expect(problems("@media (x) {\n  .a { color: red; }\n}\n")).toEqual([]);
    expect(problems(".a { color: red; } }")).toEqual(["en } för mycket"]);
  });
});
