// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { formatSek } from "@kronkoll/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.tsx";
import { MAX_WAIT_MS, POLL_MS } from "../sync/SyncButton.tsx";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

/** Påhittad översikt (KK-13) i API:ts form. */
function overview(overrides: Record<string, unknown> = {}) {
  return {
    period: { key: "2026-11", start: "2026-11-01", end: "2026-11-30" },
    balance_minor: 4831240,
    income_minor: 4125000,
    expense_minor: 2341800,
    net_minor: 1783200,
    budget_minor: 3200000,
    left_to_spend_minor: 858200,
    left_per_day_minor: 53637,
    days_left: 16,
    over: false,
    last_sync_at: "2026-11-15T05:02:11.000Z",
    connections: [{ bank: "Skandia", status: "active", consent_expires_on: "2027-05-01", consent_days_left: 167 }],
    accounts: [
      { id: "acc_1", name: "Vardag", bank: "Skandia", balance_minor: 1852790 },
      { id: "acc_2", name: "Sparkonto ••7712", bank: "Skandia", balance_minor: 2978450 },
    ],
    trend: [
      { period: "2026-10", income_minor: 3300000, expense_minor: 2900000, net_minor: 400000 },
      { period: "2026-11", income_minor: 4125000, expense_minor: 2341800, net_minor: 1783200 },
    ],
    ...overrides,
  };
}

const STARTED = "2026-11-15T10:00:00.000Z";

function api(responses: { overview?: () => [number, unknown]; sync?: [number, unknown]; progress?: () => [number, unknown] } = {}) {
  const calls: { method: string; path: string; csrf: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://app.test");
      calls.push({ method: init?.method ?? "GET", path: url.pathname, csrf: new Headers(init?.headers).get("x-kronkoll") });
      const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));
      if (url.pathname === "/api/overview") return json(...(responses.overview?.() ?? [200, overview()]));
      if (url.pathname === "/api/sync" && init?.method === "POST") return json(...(responses.sync ?? [202, { status: "started", started_at: STARTED }]));
      if (url.pathname === "/api/sync") return json(...(responses.progress?.() ?? [200, { started: 1, running: 0, done: true }]));
      return json(404, { error: "not_found" });
    }),
  );
  return calls;
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
}

async function open() {
  window.history.replaceState(null, "", "/");
  await act(async () => {
    render(<App />);
    await Promise.resolve();
  });
  await settle();
}

const text = () => screen.getByRole("main").textContent;

describe("översikten (#31, KK-17)", () => {
  it("visar periodens namn, saldo, in och ut (KK-17-A)", async () => {
    api();
    await open();
    expect(screen.getByRole("heading", { name: "Översikt" })).toBeTruthy();
    expect(text()).toContain("November");
    expect(screen.getAllByRole("definition").map((d) => d.textContent)).toEqual([formatSek(4831240), formatSek(4125000), formatSek(2341800)]);
  });

  it("visar kvar att spendera, per dag och hur mycket av budgeten som är använd (KK-17-B)", async () => {
    api();
    await open();
    expect(text()).toContain(formatSek(858200));
    expect(text()).toContain(`≈ ${formatSek(53637)} per dag i 16 dagar`);
    expect(text()).toContain("73 % av periodens budget är använd");
  });

  it("över budget står i text, och utan budget finns en länk till Budget", async () => {
    api({ overview: () => [200, overview({ left_to_spend_minor: -25200, left_per_day_minor: 0 })] });
    await open();
    expect(text()).toContain(`Över budget med ${formatSek(25200)}`);
    expect(text()).not.toContain("per dag");
    cleanup();
    api({ overview: () => [200, overview({ budget_minor: 0 })] });
    await open();
    expect(screen.getByRole("link", { name: "Sätt budget" }).getAttribute("href")).toBe("/budget");
  });

  it("listar varje konto med namn, bank och saldo under totalsaldot (KK-38-A)", async () => {
    api();
    await open();
    const rows = within(screen.getByRole("list", { name: "Konton" })).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual([
      `Vardag${formatSek(1852790)}Skandia`,
      `Sparkonto ••7712${formatSek(2978450)}Skandia`,
    ]);
    expect(screen.getAllByRole("term")[0]?.textContent).toBe("Saldo");
  });

  it("ett konto utan saldo från banken visar Saldo saknas, och totalen säger hur många konton den räknar (KK-38-B)", async () => {
    const accounts = [
      { id: "acc_1", name: "Vardag", bank: "Skandia", balance_minor: 1852790 },
      { id: "acc_3", name: "Privat kort", bank: null, balance_minor: null },
    ];
    api({ overview: () => [200, overview({ balance_minor: 1852790, accounts })] });
    await open();
    const rows = within(screen.getByRole("list", { name: "Konton" })).getAllByRole("listitem");
    expect(rows[1]?.textContent).toBe("Privat kortSaldo saknas");
    expect(screen.getAllByRole("term")[0]?.textContent).toBe("Saldo (1 av 2 konton)");
    expect(screen.getAllByRole("definition")[0]?.textContent).toBe(formatSek(1852790));
  });

  it("visar trenden som diagram och samma siffror som text för skärmläsare (KK-17-C)", async () => {
    api();
    await open();
    expect(document.querySelectorAll(".trend rect")).toHaveLength(4);
    expect(text()).toContain(`oktober: in ${formatSek(3300000)}, ut ${formatSek(2900000)}`);
  });

  it("Synka nu snurrar tills synken är klar och hämtar sedan siffrorna igen (KK-7-C)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let fetched = 0;
    let polls = 0;
    const calls = api({
      overview: () => [200, overview({ balance_minor: ++fetched === 1 ? 4831240 : 5000000 })],
      // Första frågan: pågår. Andra: klar.
      progress: () => [200, ++polls === 1 ? { started: 1, running: 1, done: false } : { started: 1, running: 0, done: true }],
    });
    await open();
    expect(text()).toContain("Senast synkad 15 nov. 06:02");
    fireEvent.click(screen.getByRole("button", { name: "Synka nu" }));
    await settle();
    expect(calls.find((c) => c.method === "POST")).toEqual({ method: "POST", path: "/api/sync", csrf: "1" });
    const button = screen.getByRole("button", { name: "Synkar…" });
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.querySelector("svg")?.getAttribute("class")).toContain("spin");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    });
    await settle();
    expect(calls.filter((c) => c.method === "GET" && c.path === "/api/sync")).toHaveLength(2);
    expect(screen.getByRole("status").textContent).toBe("Synken är klar.");
    expect(screen.getByRole("button", { name: "Synka nu" }).querySelector("svg")?.getAttribute("class")).not.toContain("spin");
    expect(screen.getAllByRole("definition")[0]?.textContent).toBe(formatSek(5000000));
  });

  it("hämtar om ändå när synken tar för lång tid, och säger det", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api({ progress: () => [200, { started: 1, running: 1, done: false }] });
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Synka nu" }));
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MAX_WAIT_MS + POLL_MS);
    });
    await settle();
    expect(screen.getByRole("alert").textContent).toContain("Synken tar längre tid än vanligt");
  });

  it.each([
    [[429, { error: "too_soon", retry_after_s: 400 }], "Du kan synka igen om 7 min."],
    [[503, { error: "not_configured" }], "Det gick inte att starta synken. Försök igen om en stund."],
  ] as [[number, unknown], string][])("säger till när synken inte startar", async (sync, message) => {
    api({ sync });
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Synka nu" }));
    await settle();
    expect(screen.getByRole("alert").textContent).toBe(message);
  });

  it("varnar när samtycket snart går ut, med både bank och dagar (KK-8-A)", async () => {
    api({ overview: () => [200, overview({ last_sync_at: null, connections: [{ bank: "Skandia", status: "active", consent_expires_on: "2026-11-25", consent_days_left: 10 }] })] });
    await open();
    expect(screen.getByRole("alert").textContent).toContain("Kopplingen till Skandia går ut om 10 dagar.");
    expect(text()).toContain("Inte synkad än");
  });

  it("utan bank visas en välkomstsida med länk till Koppla bank", async () => {
    api({ overview: () => [200, overview({ connections: [] })] });
    await open();
    expect(screen.getByRole("heading", { name: "Välkommen till Kronkoll" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Koppla bank" }).getAttribute("href")).toBe("/koppla");
  });

  it("säger till när översikten inte går att hämta", async () => {
    api({ overview: () => [503, { error: "unavailable" }] });
    await open();
    expect(screen.getByRole("alert").textContent).toContain("Det gick inte att hämta översikten");
  });
});
