// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { formatDateShort, formatSek } from "@kronkoll/domain";
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
    consent_days_left: 179,
    last_success_at: "2026-11-03T04:07:33.000Z",
    consecutive_failures: 0,
    account_count: 2,
    accounts: [
      { id: "acc_1", name: "Privat kort", type: "checking", balance_minor: 4831240 },
      { id: "acc_2", name: "Kort", type: "credit_card", balance_minor: null },
    ],
    sync_runs: [
      { kind: "manual", status: "ok", started_at: "2026-11-03T08:00:00.000Z", finished_at: "2026-11-03T08:00:05.000Z", new_count: 3, updated_count: 1, error_code: null },
      { kind: "cron", status: "failed", started_at: "2026-11-03T04:07:00.000Z", finished_at: "2026-11-03T04:07:02.000Z", new_count: 0, updated_count: 0, error_code: "UNAVAILABLE" },
      { kind: "initial", status: "partial", started_at: "2026-11-02T12:26:00.000Z", finished_at: null, new_count: 1, updated_count: 2, error_code: "SOMETHING_NEW" },
    ],
    ...overrides,
  };
}

function api(detail: [number, unknown] = [200, connection()]) {
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://app.test");
      paths.push(url.pathname);
      const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));
      if (url.pathname === "/api/connections") return json(200, { items: [connection()] });
      if (url.pathname === "/api/connections/c1") return json(...detail);
      if (url.pathname === "/api/accounts") return json(200, { items: [] });
      if (url.pathname === "/api/settings") return json(200, { budget_period_start_day: 1, current_period: { key: "2026-11", start: "2026-11-01", end: "2026-11-30" } });
      return json(404, { error: "not_found" });
    }),
  );
  return paths;
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
}

async function open(path = "/installningar/koppling/c1") {
  window.history.replaceState(null, "", path);
  await act(async () => {
    render(<App />);
    await Promise.resolve();
  });
  await settle();
}

const notes = (list: string) => within(screen.getByRole("list", { name: list })).getAllByRole("listitem").map((li) => li.querySelector(".tx-notes")?.textContent);

describe("sidan om en bankkoppling (#34, KK-7-A, KK-8-A)", () => {
  it("Inställningar länkar till kopplingen", async () => {
    api();
    await open("/installningar");
    fireEvent.click(screen.getByRole("link", { name: "Skandia" }));
    await settle();
    expect(screen.getByRole("heading", { level: 1, name: "Skandia" })).toBeTruthy();
  });

  it("visar samtycket, kontona med saldo och synkloggen i klartext", async () => {
    api();
    await open();
    expect(screen.getByText(`Samtycket gäller till ${formatDateShort("2027-05-01")} (179 dagar kvar).`)).toBeTruthy();
    const accounts = within(screen.getByRole("list", { name: "Konton" })).getAllByRole("listitem");
    expect(accounts.map((a) => a.textContent)).toEqual([`Privat kort${formatSek(4831240)}`, "Kort–"]);
    expect(notes("Synklogg")).toEqual([
      "Manuell · 3 nya, 1 uppdaterad",
      "Schemalagd · inget nytt · Banken svarade inte.",
      "Första hämtningen · 1 ny, 2 uppdaterade · SOMETHING_NEW",
    ]);
    const badges = within(screen.getByRole("list", { name: "Synklogg" })).getAllByRole("listitem").map((li) => li.querySelector(".badge")?.textContent);
    expect(badges).toEqual(["Klar", "Misslyckades", "Delvis"]);
    expect(screen.getByRole("button", { name: "Synka nu" })).toBeTruthy();
  });

  it("varnar för misslyckade synkar och ett utgånget samtycke", async () => {
    api([200, connection({ consecutive_failures: 2, consent_days_left: -3, consent_expires_on: "2026-10-31" })]);
    await open();
    expect(screen.getByRole("alert").textContent).toBe("De senaste 2 synkarna har misslyckats.");
    expect(screen.getByText(/och har gått ut\./u)).toBeTruthy();
  });

  it("utan slutdatum, konton eller synkar säger sidan det", async () => {
    api([200, connection({ consent_expires_on: null, consent_days_left: null, accounts: [], sync_runs: [] })]);
    await open();
    expect(screen.getByText("Samtycket har inget slutdatum.")).toBeTruthy();
    expect(screen.getByText("Inga konton.")).toBeTruthy();
    expect(screen.getByText("Inga synkar än.")).toBeTruthy();
  });

  it("en okänd koppling, och ett fel när den inte går att hämta", async () => {
    api([404, { error: "not_found" }]);
    await open();
    expect(screen.getByRole("heading", { name: "Kopplingen finns inte" })).toBeTruthy();
    cleanup();
    api([503, { error: "unavailable" }]);
    await open();
    expect(screen.getByRole("alert").textContent).toContain("Det gick inte att hämta kopplingen");
  });
});
