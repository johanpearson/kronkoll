// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const CATEGORIES = {
  items: [
    { id: "mat", parent_id: null, name: "Mat", kind: "expense", archived: false },
    { id: "mat-livsmedel", parent_id: "mat", name: "Livsmedel", kind: "expense", archived: false },
  ],
};

const fig = (id: string, budget: number | null, actual: number) => ({ category_id: id, budget_minor: budget, actual_minor: actual, remaining_minor: null, percent: null, over: false });

const BUDGET = {
  period: { key: "2026-11", start: "2026-11-01", end: "2026-11-30" },
  lines: [{ category_id: "mat", budget_minor: 600000 }],
  groups: [{ ...fig("mat", 600000, 52000), subcategories: [fig("mat-livsmedel", null, 52000)] }],
  uncategorized_minor: 0,
  total_budget_minor: 600000,
  total_actual_minor: 52000,
  excluded_internal_minor: 0,
};

/** Påhittad transaktion (KK-13) i API:ts form. */
const ICA = {
  id: "t1",
  status: "booked",
  transaction_date: "2026-11-03",
  amount_minor: -52000,
  counterparty: "",
  description: "ICA NARA SOFO, STOCKHOLM",
  category_id: "mat-livsmedel",
  is_internal_transfer: false,
  split: false,
};

function api() {
  const lists: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://app.test");
      const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      if (url.pathname === "/api/categories") return json(CATEGORIES);
      if (url.pathname.startsWith("/api/budgets/")) return json(BUDGET);
      lists.push(url.search);
      return json({ period: BUDGET.period, items: [ICA], next_cursor: null });
    }),
  );
  return lists;
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
}

async function open(path: string) {
  window.history.replaceState(null, "", path);
  await act(async () => {
    render(<App />);
    await Promise.resolve();
  });
  await settle();
}

describe("transaktionerna bakom en budgetrad (#33, KK-20)", () => {
  it("huvud- och underkategorier i budgeten länkar till sina transaktioner i perioden", async () => {
    api();
    await open("/budget");
    expect(screen.getByRole("link", { name: "Mat" }).getAttribute("href")).toBe("/transaktioner?period=2026-11&kategori=mat");
    fireEvent.click(screen.getByRole("button", { name: "Visa underkategorier (1)" }));
    expect(screen.getByRole("link", { name: "Livsmedel" }).getAttribute("href")).toBe("/transaktioner?period=2026-11&kategori=mat-livsmedel");
  });

  it("ett tryck öppnar transaktionerna för kategorin med underkategorier, och Visa alla tar bort filtret", async () => {
    const lists = api();
    await open("/budget");
    fireEvent.click(screen.getByRole("link", { name: "Mat" }));
    await settle();
    expect(screen.getByRole("heading", { name: "Transaktioner" })).toBeTruthy();
    expect(lists.at(-1)).toBe("?period=2026-11&category_id=mat");
    expect(screen.getByRole("note").textContent).toContain("Visar Mat med underkategorier.");
    expect(within(screen.getByRole("main")).getByText("ICA NARA SOFO, STOCKHOLM")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Visa alla" }));
    await settle();
    expect(lists.at(-1)).toBe("?period=2026-11");
    expect(screen.queryByRole("note")).toBeNull();
    expect(window.location.search).toBe("");
  });

  it("en ogiltig period i adressen ignoreras", async () => {
    const lists = api();
    await open("/transaktioner?period=november&kategori=mat");
    expect(lists.at(-1)).toBe("?category_id=mat");
  });
});
