// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.tsx";
import { describeHistory } from "./DeleteConnection.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

/** Påhittad koppling (KK-13) i API:ts form. */
const DETAIL = {
  id: "c1",
  bank: "Skandia",
  status: "active",
  consent_expires_on: "2027-05-01",
  consent_days_left: 179,
  last_success_at: null,
  consecutive_failures: 0,
  account_count: 4,
  accounts: [],
  sync_runs: [],
  history: { accounts: 4, transactions: 1842, splits: 1 },
};

function api(remove: [number, unknown] = [200, { revoked: true, deleted: { accounts: 4, transactions: 1842, splits: 1 }, backup_expiry_days: 7 }]) {
  const calls: { method: string; url: string; csrf: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://app.test");
      const method = init?.method ?? "GET";
      calls.push({ method, url: `${url.pathname}${url.search}`, csrf: new Headers(init?.headers).get("x-kronkoll") });
      const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));
      if (method === "DELETE") return json(...remove);
      return json(200, DETAIL);
    }),
  );
  return calls;
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
}

async function openQuestion() {
  window.history.replaceState(null, "", "/installningar/koppling/c1");
  await act(async () => {
    render(<App />);
    await Promise.resolve();
  });
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Radera koppling" }));
}

const deletes = (calls: { method: string; url: string; csrf: string | null }[]) => calls.filter((c) => c.method === "DELETE");

describe("radera en bankkoppling (#28, KK-11)", () => {
  it("frågar först, med vad som händer och hur mycket historik som raderas, förvalt att radera historiken", async () => {
    const calls = api();
    await openQuestion();
    expect(screen.getByRole("heading", { name: "Radera Skandia-kopplingen?" })).toBeTruthy();
    expect(screen.getByText(/Sessionen hos Enable Banking återkallas/u)).toBeTruthy();
    const box = screen.getByRole<HTMLInputElement>("checkbox", { name: /Radera även historik: 4 konton, 1\s842 transaktioner och 1 uppdelning/u });
    expect(box.checked).toBe(true);
    expect(deletes(calls)).toEqual([]);
  });

  it("raderar med historik och visar en kvittens som nämner återställningspunkterna (KK-32-A)", async () => {
    const calls = api();
    await openQuestion();
    fireEvent.click(screen.getByRole("button", { name: "Radera permanent" }));
    await settle();
    expect(deletes(calls)).toEqual([{ method: "DELETE", url: "/api/connections/c1?purge=true", csrf: "1" }]);
    expect(screen.getByRole("heading", { name: "Kopplingen är borttagen" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toMatch(/4 konton, 1\s842 transaktioner och 1 uppdelning är borttagna\. Cloudflares återställningspunkter med den gamla datan förfaller inom 7 dagar\./u);
  });

  it("utan historik återkallas bara kopplingen", async () => {
    const calls = api([200, { revoked: true, deleted: null, backup_expiry_days: 7 }]);
    await openQuestion();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Återkalla" }));
    await settle();
    expect(deletes(calls)[0]?.url).toBe("/api/connections/c1?purge=false");
    expect(screen.getByRole("status").textContent).toBe("Kopplingen är återkallad hos banken. Historiken finns kvar i Kronkoll.");
  });

  it.each([
    [502, "Det gick inte att återkalla kopplingen hos banken. Ingenting är raderat. Försök igen om en stund."],
    [503, "Det gick inte att radera kopplingen. Ingenting är raderat. Försök igen."],
  ])("säger att ingenting är raderat när det misslyckas (%i)", async (status, message) => {
    api([status, { error: "x" }]);
    await openQuestion();
    fireEvent.click(screen.getByRole("button", { name: "Radera permanent" }));
    await settle();
    expect(screen.getByRole("alert").textContent).toBe(message);
    expect(screen.queryByRole("heading", { name: "Kopplingen är borttagen" })).toBeNull();
  });

  it("Avbryt stänger frågan utan att radera", async () => {
    const calls = api();
    await openQuestion();
    fireEvent.click(screen.getByRole("button", { name: "Avbryt" }));
    expect(screen.getByRole("button", { name: "Radera koppling" })).toBeTruthy();
    expect(deletes(calls)).toEqual([]);
  });

  it("beskriver historiken med rätt ental och flertal", () => {
    expect(describeHistory({ accounts: 1, transactions: 1, splits: 0 })).toBe("1 konto, 1 transaktion och 0 uppdelningar");
  });
});
