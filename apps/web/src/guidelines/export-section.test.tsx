// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.tsx";
import type { Delivery } from "../export/deliver.ts";

const deliver = vi.hoisted(() => vi.fn<(file: File, title: string) => Promise<Delivery>>());
vi.mock("../export/deliver.ts", () => ({ deliverFile: deliver }));

beforeEach(() => {
  deliver.mockResolvedValue("downloaded");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/");
});

const CATEGORIES = { items: [{ id: "mat", parent_id: null, name: "Mat", kind: "expense", archived: false }] };
const GUIDELINES = {
  period: { key: "2026-11", start: "2026-11-01", end: "2026-11-30" },
  mode: "saving",
  saving_goal_minor: 800000,
  one_off_periods: [],
  expected_income_minor: 4000000,
  fixed_minor: 900000,
  feasible: true,
  shortfall_minor: 0,
  free_to_spend_minor: 2300000,
  remaining_free_minor: 1700000,
  per_day_minor: 106250,
  categories: [{ category_id: "mat", average_minor: 613333, normal_minor: 615000, fixed_minor: 0, saving_minor: 600000, override_minor: null, actual_minor: 650000, over_pace: true }],
};
const BUDGET = {
  period: GUIDELINES.period,
  lines: [{ category_id: "mat", budget_minor: 620000 }],
  groups: [],
  uncategorized_minor: 0,
  total_budget_minor: 620000,
  total_actual_minor: 650000,
  excluded_internal_minor: 0,
};

function api(budgetStatus = 200) {
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://app.test");
      const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));
      paths.push(url.pathname);
      if (url.pathname === "/api/categories") return json(200, CATEGORIES);
      if (url.pathname === "/api/accounts") return json(200, { items: [] });
      if (url.pathname === "/api/guidelines") return json(200, GUIDELINES);
      if (url.pathname === "/api/budgets/2026-11") return json(budgetStatus, BUDGET);
      return json(404, { error: "not_found" });
    }),
  );
  return paths;
}

const settle = () =>
  act(async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });

async function open() {
  window.history.replaceState(null, "", "/budget/riktlinjer");
  await act(async () => {
    render(<App />);
    await Promise.resolve();
  });
  await settle();
}

const head = async (file: File, bytes: number) => [...new Uint8Array(await file.slice(0, bytes).arrayBuffer())];

describe("Dela eller exportera (KK-43)", () => {
  it("Excel: hämtar periodens budget, bygger en .xlsx-fil på enheten och ger den till delning eller nedladdning (KK-43-A, KK-43-B, KK-43-C)", async () => {
    const paths = api();
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Excel (.xlsx)" }));
    await settle();
    expect(paths).toContain("/api/budgets/2026-11");
    const [file, title] = deliver.mock.calls[0] ?? [];
    expect(file?.name).toBe("kronkoll-budget-2026-11.xlsx");
    expect(file?.type).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(await head(file as File, 4)).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(title).toBe("Budget och riktlinjer 1 nov. 2026 – 30 nov. 2026");
    expect(screen.getByRole("status").textContent).toBe("Filen är nedladdad.");
  });

  it("delad via telefonens delningsmeny säger det", async () => {
    api();
    deliver.mockResolvedValue("shared");
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Excel (.xlsx)" }));
    await settle();
    expect(screen.getByRole("status").textContent).toBe("Filen är delad.");
  });

  it("att stänga delningsmenyn är inget fel och ger ingen bekräftelse", async () => {
    api();
    deliver.mockResolvedValue("cancelled");
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Excel (.xlsx)" }));
    await settle();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("utan budget att hämta skapas ingen fil och felet står i text", async () => {
    api(500);
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Excel (.xlsx)" }));
    await settle();
    expect(deliver).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Det gick inte att hämta budgeten till filen");
  });

  it("ett fel när filen ska skapas eller ges visas i text, och knapparna går att använda igen", async () => {
    api();
    deliver.mockRejectedValue(new Error("slut på minne"));
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Excel (.xlsx)" }));
    await settle();
    expect(screen.getByRole("alert").textContent).toContain("Det gick inte att skapa filen");
    expect(screen.getByRole("button", { name: "Excel (.xlsx)" }).hasAttribute("disabled")).toBe(false);
    deliver.mockResolvedValue("downloaded");
    fireEvent.click(screen.getByRole("button", { name: "Excel (.xlsx)" }));
    await settle();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
