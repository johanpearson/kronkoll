// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

// Påhittade konton (KK-13) i API:ts form.
const ACCOUNTS = {
  items: [
    { id: "acc_1", name: "Privat kort", nickname: "Privat kort", bank_name: "Privatkonto ••4821", bank: "Skandia", type: "checking" },
    { id: "acc_2", name: "Sparkonto ••7712", nickname: null, bank_name: "Sparkonto ••7712", bank: "Skandia", type: "savings" },
    { id: "acc_3", name: "Kort", nickname: null, bank_name: "Kort", bank: null, type: "credit_card" },
  ],
};

type Patch = { path: string; body: unknown; csrf: string | null };

function api(list: [number, unknown] = [200, ACCOUNTS], patch: (body: unknown) => [number, unknown] = (body) => [200, body]) {
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
      if (url.pathname === "/api/accounts") return json(...list);
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

const rows = () => within(screen.getByRole("list", { name: "Konton" })).getAllByRole("listitem");

async function rename(button: string, value: string) {
  fireEvent.click(screen.getByRole("button", { name: button }));
  fireEvent.change(screen.getByLabelText("Namn"), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "Spara" }));
  await settle();
}

describe("egna kontonamn i Inställningar (KK-37)", () => {
  it("visar kontots namn, och bankens namn och bank under ett eget namn", async () => {
    api();
    await open();
    expect(rows().map((r) => r.querySelector(".tx-name")?.textContent)).toEqual(["Privat kort", "Sparkonto ••7712", "Kort"]);
    expect(rows()[0]?.querySelector(".tx-notes")?.textContent).toBe("Privatkonto ••4821 · Skandia");
    expect(rows()[1]?.querySelector(".tx-notes")?.textContent).toBe("Skandia");
    expect(rows()[2]?.querySelector(".tx-notes")).toBeNull();
  });

  it("sätter ett eget namn med CSRF-skydd och visar det direkt (KK-37-A)", async () => {
    const patches = api(undefined, () => [200, { id: "acc_2", name: "Buffert", nickname: "Buffert" }]);
    await open();
    await rename("Byt namn på Sparkonto ••7712", "Buffert");
    expect(patches).toEqual([{ path: "/api/accounts/acc_2", body: { nickname: "Buffert" }, csrf: "1" }]);
    expect(rows()[1]?.querySelector(".tx-name")?.textContent).toBe("Buffert");
    expect(rows()[1]?.querySelector(".tx-notes")?.textContent).toBe("Sparkonto ••7712 · Skandia");
    expect(screen.queryByLabelText("Namn")).toBeNull();
  });

  it("ett tomt namn tar bort det egna, och bankens namn visas igen", async () => {
    const patches = api(undefined, () => [200, { id: "acc_1", name: "Privatkonto ••4821", nickname: null }]);
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Byt namn på Privat kort" }));
    expect(screen.getByLabelText<HTMLInputElement>("Namn").value).toBe("Privat kort");
    expect(document.activeElement).toBe(screen.getByLabelText("Namn"));
    fireEvent.change(screen.getByLabelText("Namn"), { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "Spara" }));
    await settle();
    expect(patches[0]?.body).toEqual({ nickname: null });
    expect(rows()[0]?.querySelector(".tx-name")?.textContent).toBe("Privatkonto ••4821");
  });

  it("ett namn med HTML visas som text (KK-37-C)", async () => {
    api(undefined, () => [200, { id: "acc_3", name: "<img src=x onerror=alert(1)>", nickname: "<img src=x onerror=alert(1)>" }]);
    await open();
    await rename("Byt namn på Kort", "<img src=x onerror=alert(1)>");
    expect(rows()[2]?.querySelector(".tx-name")?.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(document.querySelector("main img")).toBeNull();
  });

  it("säger varför när namnet inte godtas, och när det inte går att spara", async () => {
    let status = 400;
    api(undefined, () => [status, { error: "x" }]);
    await open();
    await rename("Byt namn på Kort", "x");
    expect(screen.getByRole("alert").textContent).toBe("Namnet får vara högst 40 tecken och inte innehålla radbrytningar.");
    status = 503;
    fireEvent.click(screen.getByRole("button", { name: "Spara" }));
    await settle();
    expect(screen.getByRole("alert").textContent).toBe("Det gick inte att spara namnet. Försök igen.");
    fireEvent.click(screen.getByRole("button", { name: "Avbryt" }));
    expect(screen.queryByLabelText("Namn")).toBeNull();
    expect(rows()[2]?.querySelector(".tx-name")?.textContent).toBe("Kort");
  });

  it("säger till när kontona inte går att hämta, och när det inte finns några", async () => {
    api([503, { error: "unavailable" }]);
    await open();
    expect(screen.getByRole("alert").textContent).toContain("Det gick inte att hämta kontona");
    cleanup();
    api([200, { items: [] }]);
    await open();
    expect(screen.getByText("Inga konton än. Koppla en bank först.")).toBeTruthy();
  });
});
