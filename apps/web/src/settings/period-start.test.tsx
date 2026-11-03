// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { formatDateShort } from "@kronkoll/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.tsx";
import { ordinal } from "./PeriodStart.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const CALENDAR = { budget_period_start_day: 1, current_period: { key: "2026-12", start: "2026-12-01", end: "2026-12-31" } };
const PAYDAY = { budget_period_start_day: 25, current_period: { key: "2027-01", start: "2026-12-23", end: "2027-01-24" } };

function api(get: [number, unknown] = [200, CALENDAR], patch: [number, unknown] = [200, PAYDAY]) {
  const patches: { body: unknown; csrf: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://app.test");
      const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));
      if (url.pathname === "/api/settings" && init?.method === "PATCH") {
        patches.push({ body: JSON.parse(typeof init.body === "string" ? init.body : "null") as unknown, csrf: new Headers(init.headers).get("x-kronkoll") });
        return json(...patch);
      }
      if (url.pathname === "/api/settings") return json(...get);
      if (url.pathname === "/api/accounts" || url.pathname === "/api/connections") return json(200, { items: [] });
      return json(404, { error: "not_found" });
    }),
  );
  return patches;
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
}

async function open() {
  window.history.replaceState(null, "", "/installningar");
  await act(async () => {
    render(<App />);
    await Promise.resolve();
  });
  await settle();
}

const select = () => screen.getByLabelText<HTMLSelectElement>("Budgetperioden börjar");

describe("budgetperiodens startdag i Inställningar (KK-34)", () => {
  it("visar valet och perioden som pågår, med kalendermånad som första alternativ", async () => {
    api();
    await open();
    expect(select().value).toBe("1");
    expect(select().options).toHaveLength(28);
    expect(select().options[0]?.textContent).toBe("Den 1:a (kalendermånad)");
    expect(select().options[24]?.textContent).toBe("Den 25:e");
    expect(screen.getByText(/Pågående period/u).textContent).toContain(`${formatDateShort("2026-12-01")} – ${formatDateShort("2026-12-31")}`);
  });

  it("sparar ett nytt val direkt med CSRF-skydd och visar den nya perioden (KK-34-A)", async () => {
    const patches = api();
    await open();
    fireEvent.change(select(), { target: { value: "25" } });
    await settle();
    expect(patches).toEqual([{ body: { budget_period_start_day: 25 }, csrf: "1" }]);
    expect(screen.getByRole("status").textContent).toBe("Sparat.");
    expect(screen.getByText(/Pågående period/u).textContent).toContain(formatDateShort("2026-12-23"));
  });

  it("säger till när valet inte går att spara, och behåller den gamla perioden", async () => {
    api(undefined, [503, { error: "unavailable" }]);
    await open();
    fireEvent.change(select(), { target: { value: "25" } });
    await settle();
    expect(screen.getByText("Det gick inte att spara. Försök igen.")).toBeTruthy();
    expect(screen.getByText(/Pågående period/u).textContent).toContain(formatDateShort("2026-12-01"));
  });

  it("säger till när inställningen inte går att hämta", async () => {
    api([503, { error: "unavailable" }]);
    await open();
    expect(screen.getByText("Det gick inte att hämta inställningen. Försök igen om en stund.")).toBeTruthy();
  });

  it.each([
    [1, "1:a"],
    [2, "2:a"],
    [3, "3:e"],
    [11, "11:e"],
    [12, "12:e"],
    [21, "21:a"],
    [22, "22:a"],
    [25, "25:e"],
  ])("dag %i heter %s", (day, text) => {
    expect(ordinal(day)).toBe(text);
  });
});
