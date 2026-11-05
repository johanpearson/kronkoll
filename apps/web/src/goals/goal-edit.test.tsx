// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.tsx";
import { toGoal } from "./goals.ts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

/** Påhittat sparmål i samma form som GET /api/goals/{id} (KK-13): 11 900 kr sparat innan avsättningarna. */
const JAPAN = {
  id: "g1", name: "Resa till Japan", target_minor: 6000000, target_date: "2027-08-31", source: "manual", account_id: null, account_missing: false,
  saved_minor: 1440000, monthly_rate_minor: 83333,
  forecast: { kind: "eta", reach_period: "2031-03", months_left: 55, on_track: false, months_late: 43, required_monthly_minor: 506666 },
  contributions: [{ id: "c2", date: "2026-10-28", amount_minor: 300000 }, { id: "c1", date: "2026-09-27", amount_minor: -50000 }],
};
const BUFFERT = { ...JAPAN, id: "g2", name: "Buffert", source: "account", account_id: "acc", target_date: null, contributions: [] };

type Call = { method: string; path: string; body: unknown };

function api(write: [number, unknown] = [200, { ...JAPAN, name: "Japan och Korea", target_minor: 7000000 }], goal: unknown = JAPAN) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://app.test");
      const json = (status: number, body: unknown) => Promise.resolve(new Response(status === 204 ? null : JSON.stringify(body), { status }));
      const method = init?.method ?? "GET";
      if (method !== "GET") {
        calls.push({ method, path: url.pathname, body: init?.body ? (JSON.parse(init.body as string) as unknown) : null });
        return json(...write);
      }
      if (url.pathname === "/api/goals") return json(200, { items: [goal] });
      if (url.pathname.startsWith("/api/goals/")) return json(200, goal);
      return json(200, { items: [] });
    }),
  );
  return calls;
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

async function open(path = "/sparmal/g1") {
  window.history.replaceState(null, "", path);
  await act(async () => {
    render(<App />);
    await Promise.resolve();
  });
  await settle();
}

const click = (name: string, scope: HTMLElement = document.body) => { fireEvent.click(within(scope).getByRole("button", { name })); };
const type = (scope: HTMLElement, label: string, value: string) => { fireEvent.change(within(scope).getByLabelText(label), { target: { value } }); };

describe("ändra och ta bort sparmål och avsättningar (KK-21-C)", () => {
  it("ändrar ett mål med sina värden ifyllda och visar den nya prognosen", async () => {
    const calls = api();
    await open();
    click("Ändra sparmål");
    const form = screen.getByRole("form", { name: "Ändra Resa till Japan" });
    expect(within(form).getByLabelText<HTMLInputElement>("Målbelopp (kr)").value).toBe("60000");
    expect(within(form).getByLabelText<HTMLInputElement>("Redan sparat innan avsättningarna (kr)").value).toBe("11900");
    type(form, "Namn", " Japan och Korea ");
    type(form, "Målbelopp (kr)", "70 000");
    type(form, "Måldatum (valfritt)", "");
    click("Spara", form);
    await settle();
    expect(calls).toEqual([{ method: "PATCH", path: "/api/goals/g1", body: { name: "Japan och Korea", target_minor: 7000000, target_date: null, initial_minor: 1190000 } }]);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Japan och Korea");
    expect(screen.getByRole("status").textContent).toBe("Sparmålet är ändrat.");
    expect(screen.queryByRole("form", { name: /^Ändra/u })).toBeNull();
  });

  it("ett kopplat mål skickar inte redan sparat, och fel visas i formuläret", async () => {
    const calls = api([422, { error: "target_date_in_past" }], BUFFERT);
    await open("/sparmal/g2");
    click("Ändra sparmål");
    const form = screen.getByRole("form", { name: "Ändra Buffert" });
    expect(within(form).queryByLabelText("Redan sparat innan avsättningarna (kr)")).toBeNull();
    type(form, "Namn", " ");
    click("Spara", form);
    expect(within(form).getByRole("alert").textContent).toBe("Ge målet ett namn.");
    type(form, "Namn", "Buffert");
    type(form, "Målbelopp (kr)", "0");
    click("Spara", form);
    expect(within(form).getByRole("alert").textContent).toBe("Skriv målbeloppet i kronor, till exempel 60 000.");
    expect(calls).toEqual([]);
    type(form, "Målbelopp (kr)", "1000,50");
    type(form, "Måldatum (valfritt)", "2026-01-01");
    click("Spara", form);
    await settle();
    expect(calls[0]?.body).toEqual({ name: "Buffert", target_minor: 100050, target_date: "2026-01-01" });
    expect(within(form).getByRole("alert").textContent).toBe("Måldatum måste vara efter i dag.");
    click("Avbryt", form);
    expect(screen.getByRole("button", { name: "Ändra sparmål" })).toBeTruthy();
  });

  it("frågar innan ett mål tas bort, och går tillbaka till listan", async () => {
    const calls = api([204, null]);
    await open();
    click("Ändra sparmål");
    const form = screen.getByRole("form", { name: "Ändra Resa till Japan" });
    click("Ta bort sparmål", form);
    expect(form.textContent).toContain("Ta bort sparmålet? Avsättningarna försvinner också. Inget hos banken ändras.");
    click("Behåll", form);
    expect(calls).toEqual([]);
    click("Ta bort sparmål", form);
    click("Ta bort sparmål", form);
    await settle();
    expect(calls).toEqual([{ method: "DELETE", path: "/api/goals/g1", body: null }]);
    expect(window.location.pathname).toBe("/sparmal");
    expect(screen.getByRole("status").textContent).toBe("Sparmålet är borttaget.");
  });

  it("ett fel vid borttagning syns och målet ligger kvar", async () => {
    api([503, { error: "unavailable" }]);
    await open();
    click("Ändra sparmål");
    const form = screen.getByRole("form", { name: "Ändra Resa till Japan" });
    click("Ta bort sparmål", form);
    click("Ta bort sparmål", form);
    await settle();
    expect(within(form).getByRole("alert").textContent).toBe("Det gick inte att ta bort sparmålet. Försök igen.");
    expect(window.location.pathname).toBe("/sparmal/g1");
    click("Behåll", form);
    click("Spara", form);
    await settle();
    expect(within(form).getByRole("alert").textContent).toBe("Det gick inte att spara. Försök igen.");
  });

  it("tar bort en avsättning efter en fråga och hämtar målet igen", async () => {
    const calls = api([204, null]);
    await open();
    const rows = () => within(screen.getByRole("list", { name: "Avsättningar" })).getAllByRole("listitem");
    click("Ta bort uttag 27 sep. 2026");
    expect(rows()[1]?.textContent).toContain("Ta bort uttaget? Sparat och takt räknas om.");
    click("Behåll", rows()[1]);
    click("Ta bort uttag 27 sep. 2026");
    click("Ta bort", rows()[1]);
    await settle();
    expect(calls).toEqual([{ method: "DELETE", path: "/api/goals/g1/contributions/c1", body: null }]);
    expect(screen.getByRole("status").textContent).toBe("Uttaget är borttaget.");
  });

  it("visar fel när en avsättning inte går att ta bort, och en avsättning utan id kan inte tas bort", async () => {
    api([503, {}], { ...JAPAN, contributions: [{ id: "c2", date: "2026-10-28", amount_minor: 300000 }, { date: "2026-09-27", amount_minor: -50000 }] });
    await open();
    expect(screen.queryByRole("button", { name: "Ta bort uttag 27 sep. 2026" })).toBeNull();
    click("Ta bort avsättning 28 okt. 2026");
    click("Ta bort", within(screen.getByRole("list", { name: "Avsättningar" })).getAllByRole("listitem")[0]);
    await settle();
    expect(screen.getByRole("alert").textContent).toBe("Det gick inte att ta bort. Försök igen.");
    expect(toGoal({ ...JAPAN, contributions: [] })?.initialMinor).toBe(1440000);
  });
});
