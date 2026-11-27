// Gesterna som rena beslut (KK-63): när ett svep byter flik och när en dragning nedåt startar en synk.
// Allt mäts i pixlar och millisekunder, så att reglerna kan testas utan pekskärm.
import { describe, expect, it } from "vitest";
import { EDGE_PX, PULL_TRIGGER_PX, neighbourTab, pullDistance, pullTriggers, swipeAxis, swipeDecision } from "./gesture.ts";

const WIDTH = 400;

describe("swipeAxis: åt vilket håll fingret rör sig (KK-63-A)", () => {
  it("bestämmer sig inte förrän fingret rört sig en bit", () => {
    expect(swipeAxis(4, 3)).toBeNull();
  });

  it("vågrätt när rörelsen är mest i sidled, annars lodrätt så att sidan kan scrolla", () => {
    expect(swipeAxis(20, 5)).toBe("x");
    expect(swipeAxis(-20, 8)).toBe("x");
    expect(swipeAxis(10, 20)).toBe("y");
    expect(swipeAxis(12, -12)).toBe("y");
  });
});

describe("swipeDecision: byter fliken eller studsar tillbaka (KK-63-A, B)", () => {
  const swipe = (dx: number, ms: number, startX = 200) => swipeDecision({ dx, ms, startX, width: WIDTH });

  it("ett långt svep åt vänster går till nästa flik och åt höger till föregående", () => {
    expect(swipe(-160, 400)).toBe("next");
    expect(swipe(160, 400)).toBe("prev");
  });

  it("ett snabbt kort svep räcker också", () => {
    expect(swipe(-60, 80)).toBe("next");
  });

  it("ett kort eller långsamt svep studsar tillbaka", () => {
    expect(swipe(-60, 400)).toBeNull();
    expect(swipe(-20, 30)).toBeNull();
  });

  it("startar inte nära skärmkanten, där systemets bakåtgest finns", () => {
    expect(swipe(160, 300, EDGE_PX - 1)).toBeNull();
    expect(swipe(-160, 300, WIDTH - EDGE_PX + 1)).toBeNull();
    expect(swipe(-160, 300, EDGE_PX)).toBe("next");
  });
});

describe("neighbourTab: menyns ordning (KK-63-A)", () => {
  it("nästa och föregående flik, och ingen bortom ändarna", () => {
    expect(neighbourTab("/", "next")).toBe("/transaktioner");
    expect(neighbourTab("/budget", "prev")).toBe("/transaktioner");
    expect(neighbourTab("/inkomst", "prev")).toBe("/lan");
    expect(neighbourTab("/", "prev")).toBeNull();
    expect(neighbourTab("/inkomst", "next")).toBeNull();
  });
});

describe("dra för att synka (KK-63-D)", () => {
  it("indikatorn följer fingret men allt trögare, och aldrig uppåt", () => {
    expect(pullDistance(-30)).toBe(0);
    expect(pullDistance(0)).toBe(0);
    expect(pullDistance(100)).toBe(50);
    expect(pullDistance(400)).toBeLessThan(150);
    expect(pullDistance(400)).toBeGreaterThan(pullDistance(300));
  });

  it("startar en synk när den dragits förbi gränsen, och bara då", () => {
    expect(pullTriggers(PULL_TRIGGER_PX)).toBe(true);
    expect(pullTriggers(PULL_TRIGGER_PX - 1)).toBe(false);
  });
});
