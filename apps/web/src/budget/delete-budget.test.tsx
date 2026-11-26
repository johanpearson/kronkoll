// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const CATEGORIES = { items: [{ id: "mat", parent_id: null, name: "Mat", kind: "expense", archived: false }] };

/** Påhittad period (KK-13), med eller utan budget för Mat. */
function november(withBudget: boolean) {
  const planned = withBudget ? 630000 : null;
  return {
    period: { key: "2026-11", start: "2026-11-01", end: "2026-11-30" },
    lines: withBudget ? [{ category_id: "mat", budget_minor: 630000 }] : [],
    groups: [{ category_id: "mat", actual_minor: 655200, budget_minor: planned, remaining_minor: planned === null ? null : planned - 655200, percent: withBudget ? 104 : null, over: withBudget, subcategories: [] }],
    uncategorized_minor: 0,
    total_budget_minor: planned ?? 0,
    total_actual_minor: 655200,
    excluded_internal_minor: 0,
  };
}

/** Underlag till planeraren (KK-13). */
const GUIDELINES = {
  period: { key: "2026-11", start: "2026-11-01", end: "2026-11-30" },
  one_off_periods: [],
  expected_income_minor: 0,
  fixed_minor: 0,
  categories: [{ category_id: "mat", average_minor: 600000, normal_minor: 600000, fixed_minor: 0, actual_minor: 655200, last_minor: 590000 }],
};

/** Ett API där budgeten finns tills DELETE lyckas. */
function api(deleteStatus = 204, withBudget = true) {
  let hasBudget = withBudget;
  const deletes: { path: string; csrf: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://app.test");
      const json = (status: number, body: unknown) => Promise.resolve(new Response(status === 204 ? null : JSON.stringify(body), { status }));
      if (url.pathname === "/api/categories") return json(200, CATEGORIES);
      if (url.pathname === "/api/accounts") return json(200, { items: [] });
      if (url.pathname === "/api/guidelines") return json(200, GUIDELINES);
      if (init?.method === "DELETE") {
        deletes.push({ path: url.pathname, csrf: new Headers(init.headers).get("x-kronkoll") });
        if (deleteStatus === 204) hasBudget = false;
        return json(deleteStatus, { error: "unavailable" });
      }
      return json(200, november(hasBudget));
    }),
  );
  return deletes;
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
}

async function open() {
  window.history.replaceState(null, "", "/budget");
  await act(async () => {
    render(<App />);
    await Promise.resolve();
  });
  await settle();
}

async function click(name: string, within_: HTMLElement = document.body) {
  fireEvent.click(within(within_).getByRole("button", { name }));
  await settle();
}

const dialog = () => screen.getByRole("region", { name: "Ta bort budgeten" });

describe("ta bort en periods budget (KK-40)", () => {
  it("frågar först och säger vad som händer, och Avbryt ändrar ingenting (KK-40-B)", async () => {
    const deletes = api();
    await open();
    await click("Ta bort budget");
    expect(dialog().textContent).toContain("Budgeten för 1 kategori tas bort. Utfallet och transaktionerna ändras inte, och andra perioder påverkas inte.");
    await click("Avbryt", dialog());
    expect(screen.queryByRole("region", { name: "Ta bort budgeten" })).toBeNull();
    expect(deletes).toEqual([]);
    expect(screen.getByRole("button", { name: "Ta bort budget" })).toBeDefined();
  });

  it("tar bort periodens budget med CSRF-header och visar perioden utan budget (KK-40-A)", async () => {
    const deletes = api();
    await open();
    await click("Ta bort budget");
    await click("Ta bort budget", dialog());
    expect(deletes).toEqual([{ path: "/api/budgets/2026-11", csrf: "1" }]);
    expect(screen.getByRole("status").textContent).toBe("Budgeten för perioden är borttagen.");
    // Utan sparad budget är utgångsläget normalnivån igen.
    expect(screen.getByLabelText<HTMLInputElement>("Utgift för Mat (kr)").value).toBe("6000");
    expect(screen.queryByRole("button", { name: "Ta bort budget" })).toBeNull();
  });

  it("säger till när det inte gick, och budgeten finns kvar", async () => {
    api(503);
    await open();
    await click("Ta bort budget");
    await click("Ta bort budget", dialog());
    expect(within(dialog()).getByRole("alert").textContent).toBe("Det gick inte att ta bort budgeten. Ingenting är ändrat. Försök igen.");
    expect(screen.getByRole("button", { name: "Ta bort budget" })).toBeDefined();
  });

  it("en period utan budget har ingen knapp för att ta bort", async () => {
    api(204, false);
    await open();
    expect(screen.getByLabelText<HTMLInputElement>("Utgift för Mat (kr)").value).toBe("6000");
    expect(screen.queryByRole("button", { name: "Ta bort budget" })).toBeNull();
  });
});
