// @vitest-environment jsdom
import { CATEGORY_TEMPLATE } from "@kronkoll/domain";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CATEGORY_COLORS, CategoryDot, categoryColor } from "./category-color.tsx";
import css from "./styles/components.css?raw";

afterEach(cleanup);

const parentOf = new Map(CATEGORY_TEMPLATE.map((c) => [c.id, c.parentId]));
const mains = CATEGORY_TEMPLATE.filter((c) => c.parentId === null).map((c) => c.id);

describe("färg per huvudkategori (KK-26-D, V-u-catcolor)", () => {
  it("varje huvudkategori i mallen har en egen färg", () => {
    const colors = mains.map((id) => categoryColor(id, parentOf));
    expect(new Set(colors).size).toBe(mains.length);
    expect(categoryColor("mat", parentOf)).toBe("green");
  });

  it("en underkategori har huvudkategorins färg", () => {
    expect(categoryColor("mat-livsmedel", parentOf)).toBe(categoryColor("mat", parentOf));
    expect(categoryColor("boende-el", parentOf)).toBe("blue");
  });

  it("en egen kategori får alltid samma färg ur paletten, och dess underkategorier med", () => {
    const own = new Map<string, string | null>([["husdjur", null], ["husdjur-foder", "husdjur"]]);
    const color = categoryColor("husdjur", own);
    expect(CATEGORY_COLORS).toContain(color);
    expect(categoryColor("husdjur", own)).toBe(color);
    expect(categoryColor("husdjur-foder", own)).toBe(color);
    expect(new Set(["a", "b", "c", "d", "e", "f"].map((id) => categoryColor(id, new Map()))).size).toBeGreaterThan(1);
  });

  it("varje färg har en stilregel, och pricken är dold för skärmläsare", () => {
    for (const color of CATEGORY_COLORS) expect(css).toContain(`.cat-${color} {`);
    const { container } = render(<CategoryDot categoryId="mat-livsmedel" parentOf={parentOf} />);
    const dot = container.firstElementChild;
    expect(dot?.className).toBe("cat-dot cat-green");
    expect(dot?.getAttribute("aria-hidden")).toBe("true");
  });
});
