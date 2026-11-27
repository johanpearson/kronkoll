// Historiken som i en app (KK-62): vilka steg bakåt som finns för en adress, och hur webbläsarens
// historik ska ändras när man byter vy. Ren logik utan DOM, så att reglerna testas var för sig.
import { describe, expect, it } from "vitest";
import { canonicalStack, plan, tabOf } from "./stack.ts";

describe("tabOf", () => {
  it.each([
    ["/", "/"],
    ["/insikter", "/"],
    ["/installningar", "/"],
    ["/installningar/regler", "/"],
    ["/installningar/koppling/k-1", "/"],
    ["/koppla/samtycke", "/"],
    ["/transaktioner", "/transaktioner"],
    ["/transaktioner/t-1", "/transaktioner"],
    ["/budget", "/budget"],
    ["/lan", "/lan"],
    ["/inkomst", "/inkomst"],
    ["/finns-inte", "/"],
  ])("%s hör till fliken %s", (path, tab) => {
    expect(tabOf(path)).toBe(tab);
  });
});

describe("canonicalStack: stegen bakåt från en djuplänk (KK-62-G)", () => {
  it("Översikt har bara ett steg, så att bakåt stänger appen (KK-62-D)", () => {
    expect(canonicalStack("/")).toEqual(["/"]);
  });

  it("en annan flik har Översikt bakom sig (KK-62-C)", () => {
    expect(canonicalStack("/budget")).toEqual(["/", "/budget"]);
  });

  it("en undervy har sin flik och sedan Översikt bakom sig (KK-62-B)", () => {
    expect(canonicalStack("/transaktioner/t-1")).toEqual(["/", "/transaktioner", "/transaktioner/t-1"]);
  });

  it("sidor under Inställningar har Inställningar och Översikt bakom sig", () => {
    expect(canonicalStack("/installningar/regler")).toEqual(["/", "/installningar", "/installningar/regler"]);
    expect(canonicalStack("/installningar/koppling/k-1")).toEqual(["/", "/installningar", "/installningar/koppling/k-1"]);
    expect(canonicalStack("/insikter")).toEqual(["/", "/insikter"]);
  });

  it("bankkopplingens steg leder bakåt genom flödet, men klar-sidan går till Inställningar", () => {
    expect(canonicalStack("/koppla/samtycke")).toEqual(["/", "/installningar", "/koppla", "/koppla/samtycke"]);
    expect(canonicalStack("/koppla/klar")).toEqual(["/", "/installningar", "/koppla/klar"]);
  });

  it("en okänd adress har Översikt bakom sig", () => {
    expect(canonicalStack("/finns-inte")).toEqual(["/", "/finns-inte"]);
  });
});

describe("plan: hur historiken ändras", () => {
  it("att öppna en undervy lägger till ett steg", () => {
    expect(plan(["/", "/transaktioner"], ["/", "/transaktioner", "/transaktioner/t-1"])).toEqual({ back: 0, push: ["/transaktioner/t-1"] });
  });

  it("att byta flik ersätter fliken i stället för att lägga till ett steg (KK-62-A)", () => {
    expect(plan(["/", "/budget"], canonicalStack("/lan"))).toEqual({ back: 1, push: ["/lan"] });
    expect(plan(["/"], canonicalStack("/lan"))).toEqual({ back: 0, push: ["/lan"] });
  });

  it("att gå till Översikt från en flik med undervy går tillbaka till första steget", () => {
    expect(plan(["/", "/transaktioner", "/transaktioner/t-1"], ["/"])).toEqual({ back: 2, push: [] });
  });

  it("att stå kvar gör ingenting", () => {
    expect(plan(["/", "/budget"], ["/", "/budget"])).toEqual({ back: 0, push: [] });
  });

  it("går aldrig bakåt förbi appens första steg, utan ersätter det", () => {
    // Om historiken av någon anledning börjar på en annan sida än Översikt.
    expect(plan(["/budget"], ["/"])).toEqual({ back: 0, push: [], replace: "/" });
    expect(plan(["/budget"], ["/", "/lan"])).toEqual({ back: 0, push: ["/lan"], replace: "/" });
  });
});
