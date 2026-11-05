// @vitest-environment jsdom
import { formatSek } from "@kronkoll/domain";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.tsx";
import { formatRate, toLoan } from "./loan.ts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

/** Påhittade lån i samma form som GET /api/loans (KK-13). */
const BOLAN = {
  id: "l1", name: "Bolån del 1", lender: "Exempelbanken", balance_minor: 120_000_000, interest_rate_bp: 350, rate_fixed_until: "2026-12-15", amortization_minor: 200_000,
  monthly_interest_minor: 350_000, monthly_amortization_minor: 200_000, monthly_cost_minor: 550_000, rate_fixed: true, rate_fixed_days_left: 41, rate_fixed_ending: true,
};
const BIL = {
  id: "l2", name: "Billån", lender: null, balance_minor: 8_600_000, interest_rate_bp: 695, rate_fixed_until: null, amortization_minor: 245_000,
  monthly_interest_minor: 49_808, monthly_amortization_minor: 245_000, monthly_cost_minor: 294_808, rate_fixed: false, rate_fixed_days_left: null, rate_fixed_ending: false,
};
const LIST = { loans: [BOLAN, BIL], total_balance_minor: 128_600_000, total_monthly_interest_minor: 399_808, total_monthly_amortization_minor: 445_000, total_monthly_cost_minor: 844_808 };

function api(list: [number, unknown] = [200, LIST]) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://app.test");
      const [status, body] = url.pathname === "/api/loans" ? list : [200, { items: [] }];
      return Promise.resolve(new Response(JSON.stringify(body), { status }));
    }),
  );
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

async function open(path = "/sparmal/lan") {
  window.history.replaceState(null, "", path);
  await act(async () => {
    render(<App />);
    await Promise.resolve();
  });
  await settle();
}

const rows = () => within(screen.getByRole("list", { name: "Dina lån" })).getAllByRole("listitem");

describe("Lån (#72, KK-36)", () => {
  it("nås från Sparmål och visar totalsummor och varje lån (KK-36-C)", async () => {
    api();
    await open("/sparmal");
    fireEvent.click(screen.getByRole("button", { name: "Lån" }));
    await settle();
    expect(window.location.pathname).toBe("/sparmal/lan");
    expect(screen.getAllByRole("definition").map((d) => d.textContent)).toEqual([formatSek(128_600_000), formatSek(844_808)]);
    expect(rows()[0]?.textContent).toContain(`Bolån del 1 · Exempelbanken${formatSek(550_000)}/mån`);
    expect(rows()[0]?.textContent).toContain(`Skuld ${formatSek(120_000_000)} · 3,50 % · ränta ${formatSek(350_000)} + amortering ${formatSek(200_000)}`);
    expect(rows()[1]?.textContent).toContain("Billån");
    expect(rows()[1]?.textContent).not.toContain("·  ·");
    expect(screen.getByRole("note").textContent).toBe(
      `Varje månad: ${formatSek(399_808)} ränta och ${formatSek(445_000)} amortering. Lånebetalningarna räknas hela som boendekostnad i budgeten.`,
    );
  });

  it("markerar bindningstid som slutar inom 60 dagar med färg och text, men inte rörlig ränta", async () => {
    api([200, { ...LIST, loans: [BOLAN, BIL, { ...BOLAN, id: "l3", name: "Del 2", rate_fixed_days_left: 0 }, { ...BOLAN, id: "l4", name: "Del 3", rate_fixed_days_left: 400, rate_fixed_ending: false }] }]);
    await open();
    const [del1, bil, del2, del3] = rows();
    expect(del1?.querySelector(".badge")?.textContent).toBe("Bindningstiden slutar om 41 dagar");
    expect(del1?.querySelector(".badge")?.className).toBe("badge warn");
    expect(del2?.querySelector(".badge")?.textContent).toBe("Bindningstiden slutar i dag");
    expect(bil?.querySelector(".badge")).toBeNull();
    expect(bil?.textContent).toContain("Rörlig ränta");
    expect(del3?.textContent).toContain("Bunden ränta i 400 dagar till");
  });

  it("utan lån visas en förklaring, och fel vid hämtning syns", async () => {
    api([200, { loans: [], total_balance_minor: 0 }]);
    await open();
    expect(screen.getByRole("main").textContent).toContain("Ett bolån i flera delar läggs in som ett lån per del.");
    cleanup();
    api([503, { error: "unavailable" }]);
    await open();
    expect(screen.getByRole("alert").textContent).toBe("Det gick inte att hämta lånen. Försök igen om en stund.");
  });

  it("tål svar med saknade fält och visar räntan med två decimaler", () => {
    expect(toLoan({ name: "x" })).toBeNull();
    expect(toLoan({ id: "x", name: "Lån" })).toMatchObject({ lender: null, balanceMinor: 0, daysLeft: null, ending: false, rateFixed: false });
    expect(formatRate(695)).toBe("6,95 %");
    expect(formatRate(0)).toBe("0,00 %");
  });
});
