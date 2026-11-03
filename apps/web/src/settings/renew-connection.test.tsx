// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.tsx";
import { browser } from "../browser.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

/** Påhittad koppling (KK-13) i API:ts form. */
function detail(days: number) {
  return {
    id: "c1",
    bank: "Skandia",
    status: days < 0 ? "expired" : "active",
    consent_expires_on: "2026-11-20",
    consent_days_left: days,
    last_success_at: null,
    consecutive_failures: 0,
    account_count: 1,
    accounts: [],
    sync_runs: [],
    history: { accounts: 1, transactions: 10, splits: 0 },
  };
}

function overview(days: number) {
  return {
    period: { key: "2026-11", start: "2026-11-01", end: "2026-11-30" },
    balance_minor: 0,
    income_minor: 0,
    expense_minor: 0,
    budget_minor: 0,
    left_to_spend_minor: 0,
    left_per_day_minor: null,
    days_left: 10,
    last_sync_at: null,
    connections: [{ id: "c1", bank: "Skandia", status: "active", consent_expires_on: "2026-11-20", consent_days_left: days }],
    trend: [],
  };
}

function api(options: { days?: number; renew?: [number, unknown] } = {}) {
  const calls: { method: string; path: string; csrf: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://app.test");
      const method = init?.method ?? "GET";
      calls.push({ method, path: url.pathname, csrf: new Headers(init?.headers).get("x-kronkoll") });
      const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));
      if (url.pathname.endsWith("/renew")) return json(...(options.renew ?? [200, { redirect_url: "https://tilisy.enablebanking.com/welcome?x=1", connection_id: "c1" }]));
      if (url.pathname === "/api/overview") return json(200, overview(options.days ?? 5));
      if (url.pathname === "/api/connections/callback") return json(201, { connection_id: "c1", accounts: 2, initial_sync: "started", renewed: true });
      return json(200, detail(options.days ?? 5));
    }),
  );
  return calls;
}

async function open(path: string) {
  window.history.replaceState(null, "", path);
  await act(async () => {
    render(<App />);
    await Promise.resolve();
  });
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
}

describe("förnya samtycket (#27, KK-8)", () => {
  it("Förnya med BankID startar förnyelsen med CSRF-skydd och skickar vidare till banken", async () => {
    const calls = api();
    const assign = vi.spyOn(browser, "assign").mockImplementation(() => undefined);
    await open("/installningar/koppling/c1");
    const button = screen.getByRole("button", { name: "Förnya med BankID" });
    expect(button.className).toBe("primary");
    fireEvent.click(button);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(calls.find((c) => c.method === "POST")).toEqual({ method: "POST", path: "/api/connections/c1/renew", csrf: "1" });
    expect(assign).toHaveBeenCalledWith("https://tilisy.enablebanking.com/welcome?x=1");
  });

  it("knappen är inte framträdande när det är långt kvar", async () => {
    api({ days: 160 });
    await open("/installningar/koppling/c1");
    expect(screen.getByRole("button", { name: "Förnya med BankID" }).className).toBe("");
  });

  it.each([
    [502, "Banken svarade inte. Försök igen om en stund."],
    [503, "Det gick inte att starta förnyelsen. Försök igen."],
  ])("säger till när förnyelsen inte startar (%i)", async (status, message) => {
    api({ renew: [status, { error: "x" }] });
    const assign = vi.spyOn(browser, "assign").mockImplementation(() => undefined);
    await open("/installningar/koppling/c1");
    fireEvent.click(screen.getByRole("button", { name: "Förnya med BankID" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole("alert").textContent).toBe(message);
    expect(assign).not.toHaveBeenCalled();
  });

  it("varningen på översikten länkar till kopplingen, och säger när samtycket har gått ut (KK-8-A)", async () => {
    api({ days: 5 });
    await open("/");
    expect(screen.getByRole("alert").textContent).toContain("Kopplingen till Skandia går ut om 5 dagar.");
    expect(screen.getByRole("link", { name: "Förnya med BankID" }).getAttribute("href")).toBe("/installningar/koppling/c1");
    cleanup();
    api({ days: -2 });
    await open("/");
    expect(screen.getByRole("alert").textContent).toContain("Samtycket för Skandia har gått ut, så inget nytt hämtas.");
  });

  it("när man kommer tillbaka från banken säger sidan att kopplingen är förnyad", async () => {
    api();
    await open("/koppla/klar?code=kod-1&state=abc.def");
    expect(screen.getByRole("heading", { name: "Förnyat! Hämtar det som hänt sedan sist…" })).toBeTruthy();
    expect(screen.getByText(/Dina konton, kategorier och historik finns kvar/u)).toBeTruthy();
  });
});
