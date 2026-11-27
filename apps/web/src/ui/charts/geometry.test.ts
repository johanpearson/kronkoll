// Geometrin i diagrammen (KK-65-B, KK-66): ren matematik från belopp till SVG, utan DOM.
import { describe, expect, it } from "vitest";
import { barRects, linePoints, ringOffset } from "./geometry.ts";

describe("barRects", () => {
  it("delar bredden lika, med mellanrum, och skalar mot det största värdet", () => {
    expect(barRects([100, 50, 0], { width: 100, height: 50, gap: 5 })).toEqual([
      { x: 0, y: 0, width: 30, height: 50 },
      { x: 35, y: 25, width: 30, height: 25 },
      { x: 70, y: 50, width: 30, height: 0 },
    ]);
  });

  it("kan skala mot ett eget max, t.ex. budgeten, och kapar det som går över", () => {
    expect(barRects([200, 50], { width: 50, height: 100, gap: 0, max: 100 })).toEqual([
      { x: 0, y: 0, width: 25, height: 100 },
      { x: 25, y: 50, width: 25, height: 50 },
    ]);
  });

  it("ritar negativa värden och bara nollor som tomma staplar", () => {
    expect(barRects([-30, 0], { width: 20, height: 10, gap: 0 }).map((r) => r.height)).toEqual([0, 0]);
    expect(barRects([], { width: 20, height: 10, gap: 0 })).toEqual([]);
  });
});

describe("ringOffset", () => {
  it("är hela omkretsen vid noll och noll när målet är nått", () => {
    expect(ringOffset(0, 100, 200)).toBe(200);
    expect(ringOffset(25, 100, 200)).toBe(150);
    expect(ringOffset(100, 100, 200)).toBe(0);
  });

  it("stannar vid en hel ring när värdet går över, och är tom utan mål", () => {
    expect(ringOffset(150, 100, 200)).toBe(0);
    expect(ringOffset(-5, 100, 200)).toBe(200);
    expect(ringOffset(50, 0, 200)).toBe(200);
  });
});

describe("linePoints", () => {
  it("sprider punkterna över bredden och vänder y så att större är högre", () => {
    expect(linePoints([0, 50, 100], { width: 100, height: 40 })).toBe("0,40 50,20 100,0");
  });

  it("klarar negativa värden genom att skala mellan minsta och största", () => {
    expect(linePoints([-10, 10], { width: 10, height: 20 })).toBe("0,20 10,0");
  });

  it("lägger en ensam punkt eller en rak serie i mitten", () => {
    expect(linePoints([5], { width: 10, height: 20 })).toBe("5,10");
    expect(linePoints([3, 3], { width: 10, height: 20 })).toBe("0,10 10,10");
    expect(linePoints([], { width: 10, height: 20 })).toBe("");
  });
});
