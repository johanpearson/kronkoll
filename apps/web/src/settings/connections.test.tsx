// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { formatDateShort } from "@kronkoll/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

/** Påhittad koppling (KK-13) i API:ts form. */
function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: "c1",
    bank: "Skandia",
    status: "active",
    consent_expires_on: "2027-05-01",
    consent_days_left: 167,
    last_success_at: "2026-11-15T05:02:11.000Z",
    consecutive_failures: 0,
    account_count: 4,
    ...overrides,
  };
}

function api(connections: [number, unknown]) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://app.test");
      const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));
      if (url.pathname === "/api/connections") return json(...connections);
      if (url.pathname === "/api/accounts") return json(200, { items: [] });
      if (url.pathname === "/api/settings") return json(200, { budget_period_start_day: 1, current_period: { key: "2026-11", start: "2026-11-01", end: "2026-11-30" } });
      return json(404, { error: "not_found" });
    }),
  );
}

async function open() {
  window.history.replaceState(null, "", "/installningar");
  await act(async () => {
    render(<App />);
    await Promise.resolve();
  });
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
}

const rows = () => within(screen.getByRole("list", { name: "Bankkopplingar" })).getAllByRole("listitem");
const badge = (row: HTMLElement | undefined) => row?.querySelector(".badge");

describe("bankkopplingar i Inställningar (#34, KK-7-A, KK-8-A)", () => {
  it("visar banken, status, antal konton, samtyckets slut och senaste synk", async () => {
    api([200, { items: [connection()] }]);
    await open();
    expect(rows()[0]?.querySelector(".tx-name")?.textContent).toBe("Skandia");
    expect(badge(rows()[0])?.textContent).toBe("Aktiv");
    expect(rows()[0]?.querySelector(".tx-notes")?.textContent).toBe(`4 konton · samtycke till ${formatDateShort("2027-05-01")} · senast synkad 15 nov. 06:02`);
    expect(screen.getByRole("link", { name: "Koppla en till bank" }).getAttribute("href")).toBe("/koppla");
  });

  it.each([
    [{ consent_days_left: 10, consent_expires_on: "2026-11-25" }, "Går snart ut", "warn", "10 dagar kvar"],
    [{ consecutive_failures: 3 }, "Synken misslyckas", "bad", "3 misslyckade synkar i rad"],
    [{ status: "expired", consent_days_left: -2 }, "Utgången", "bad", "4 konton"],
    [{ status: "revoked" }, "Återkallad", "bad", "4 konton"],
  ])("ett problem står i text, inte bara i färg: %j", async (overrides, text, tone, detail) => {
    api([200, { items: [connection(overrides)] }]);
    await open();
    expect(badge(rows()[0])?.textContent).toBe(text);
    expect(badge(rows()[0])?.className).toContain(tone);
    expect(rows()[0]?.querySelector(".tx-notes")?.textContent).toContain(detail);
  });

  it("en koppling med ett konto som aldrig synkats säger det", async () => {
    api([200, { items: [connection({ account_count: 1, last_success_at: null, consent_expires_on: null, consent_days_left: null })] }]);
    await open();
    expect(rows()[0]?.querySelector(".tx-notes")?.textContent).toBe("1 konto · inte synkad än");
  });

  it("utan kopplingar finns bara länken Koppla bank", async () => {
    api([200, { items: [] }]);
    await open();
    expect(screen.queryByRole("list", { name: "Bankkopplingar" })).toBeNull();
    expect(screen.getByRole("link", { name: "Koppla bank" })).toBeTruthy();
  });

  it("säger till när kopplingarna inte går att hämta, och länken finns kvar", async () => {
    api([503, { error: "unavailable" }]);
    await open();
    expect(screen.getByText("Det gick inte att hämta bankkopplingarna. Försök igen om en stund.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Koppla bank" })).toBeTruthy();
  });
});
