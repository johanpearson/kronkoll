// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

// Påhittade konton (KK-13) i API:ts form. Det andra räknas inte med, det tredje saknar fältet.
const ACCOUNTS = {
  items: [
    { id: "acc_1", name: "Gemensamt", nickname: "Gemensamt", bank_name: "Privatkonto ••4821", bank: "Skandia", type: "checking", counted: true },
    { id: "acc_2", name: "Privat sparande", nickname: "Privat sparande", bank_name: "Sparkonto ••7712", bank: "Skandia", type: "savings", counted: false },
    { id: "acc_3", name: "Kort", nickname: null, bank_name: "Kort", bank: null, type: "credit_card" },
  ],
};

type Patch = { path: string; body: unknown; csrf: string | null };

function api(patch: (body: unknown) => [number, unknown] = (body) => [200, { id: "acc_1", ...(body as object) }]) {
  const patches: Patch[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://app.test");
      const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));
      if (init?.method === "PATCH") {
        const body: unknown = JSON.parse(typeof init.body === "string" ? init.body : "null");
        patches.push({ path: url.pathname, body, csrf: new Headers(init.headers).get("x-kronkoll") });
        return json(...patch(body));
      }
      if (url.pathname === "/api/accounts") return json(200, ACCOUNTS);
      if (url.pathname === "/api/connections") return json(200, { items: [] });
      if (url.pathname === "/api/settings") return json(200, { budget_period_start_day: 1, current_period: { key: "2026-11", start: "2026-11-01", end: "2026-11-30" } });
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

const toggle = (name: string) => screen.getByRole<HTMLInputElement>("switch", { name: `Räknas med: ${name}` });
const rows = () => within(screen.getByRole("list", { name: "Konton" })).getAllByRole("listitem");

describe("Räknas med per konto i Inställningar (KK-41-A)", () => {
  it("visar en brytare per konto, på som standard, och en text när kontot inte räknas med", async () => {
    api();
    await open();
    expect([toggle("Gemensamt").checked, toggle("Privat sparande").checked, toggle("Kort").checked]).toEqual([true, false, true]);
    expect(rows().map((r) => within(r).queryByText("Räknas inte i budget, översikt eller insikter") !== null)).toEqual([false, true, false]);
  });

  it("sparar valet med CSRF-skydd och visar det direkt", async () => {
    const patches = api((body) => [200, { id: "acc_1", name: "Gemensamt", nickname: "Gemensamt", ...(body as object) }]);
    await open();
    fireEvent.click(toggle("Gemensamt"));
    await settle();
    expect(patches).toEqual([{ path: "/api/accounts/acc_1", body: { counted: false }, csrf: "1" }]);
    expect(toggle("Gemensamt").checked).toBe(false);
    expect(within(rows()[0] as HTMLElement).getByText("Räknas inte i budget, översikt eller insikter")).toBeTruthy();
    fireEvent.click(toggle("Privat sparande"));
    await settle();
    expect(patches[1]).toMatchObject({ path: "/api/accounts/acc_2", body: { counted: true } });
    expect(toggle("Privat sparande").checked).toBe(true);
  });

  it("ändrar inget och visar ett fel när sparandet misslyckas", async () => {
    api(() => [503, { error: "unavailable" }]);
    await open();
    fireEvent.click(toggle("Gemensamt"));
    await settle();
    expect(toggle("Gemensamt").checked).toBe(true);
    expect(screen.getByRole("alert").textContent).toBe("Det gick inte att spara. Försök igen.");
    fireEvent.click(toggle("Gemensamt"));
    await settle();
    expect(screen.getByRole("alert")).toBeTruthy();
  });
});
