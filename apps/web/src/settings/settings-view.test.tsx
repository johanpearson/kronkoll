// @vitest-environment jsdom
// Inställningar som grupperade listrader (#259): varje rad leder till sin undervy, som har en tillbakaknapp
// (KK-62-B). Inga textlänkar mitt i texten (KK-65).
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.tsx";
import { startHistory } from "../router.tsx";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }))),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

function at(path: string) {
  window.history.replaceState(null, "", path);
  startHistory();
  return render(<App />);
}

describe("Inställningar (#259)", () => {
  it("grupperar raderna och leder varje rad till sin sida", () => {
    at("/installningar");
    const rows = (name: string) => within(screen.getByRole("list", { name })).getAllByRole("link").map((l) => [l.textContent, l.getAttribute("href")]);
    expect(rows("Konton och bank")).toEqual([
      ["KontonRoller och egna namn", "/installningar/konton"],
      ["BankKopplingar och samtycke", "/installningar/bank"],
    ]);
    expect(rows("Budget")).toEqual([
      ["Kategorier", "/installningar/kategorier"],
      ["Regler", "/installningar/regler"],
      ["Kända kontonKonton utanför appen, till exempel en partners", "/installningar/kanda-konton"],
      ["BudgetperiodVilken dag perioden börjar", "/installningar/budgetperiod"],
    ]);
    expect(rows("Appen")).toEqual([
      ["Notiser", "/installningar/notiser"],
      ["Om appenVersion och integritet", "/installningar/om"],
    ]);
    expect(screen.getByRole("button", { name: "Logga ut och rensa enheten" })).toBeTruthy();
  });

  it.each([
    ["Konton", "/installningar/konton"],
    ["Bank", "/installningar/bank"],
    ["Budgetperiod", "/installningar/budgetperiod"],
    ["Notiser", "/installningar/notiser"],
    ["Om appen", "/installningar/om"],
  ])("%s har en egen sida med tillbakaknapp till Inställningar", async (title, path) => {
    at("/installningar");
    fireEvent.click(screen.getByRole("link", { name: new RegExp(`^${title}`, "u") }));
    expect(window.location.pathname).toBe(path);
    expect(screen.getByRole("heading", { level: 1, name: title })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Tillbaka" }));
    await waitFor(() => {
      expect(window.location.pathname).toBe("/installningar");
    });
  });

  it("Om appen visar versionen och vad som gäller för bankdata", () => {
    at("/installningar/om");
    // I Actions är versionen commitens början, lokalt finns ingen.
    expect(screen.getByRole("heading", { name: "Version" }).closest("section")?.textContent).toMatch(/^Version(?:[0-9a-f]{7}|Utvecklingsversion)$/u);
    const privacy = screen.getByRole("heading", { name: "Integritet" }).closest("section")?.textContent ?? "";
    expect(privacy).toContain("bara läsbehörighet hos banken");
    expect(privacy).toContain("inte göra betalningar");
    expect(screen.getByRole("heading", { name: "Villkor" })).toBeTruthy();
  });
});
