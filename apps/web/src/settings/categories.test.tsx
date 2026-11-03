// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const CATEGORIES = {
  items: [
    { id: "mat", parent_id: null, name: "Mat", kind: "expense", archived: false },
    { id: "mat-livsmedel", parent_id: "mat", name: "Livsmedel", kind: "expense", archived: false },
    { id: "mat-restaurang", parent_id: "mat", name: "Restaurang", kind: "expense", archived: false },
    { id: "boende", parent_id: null, name: "Boende", kind: "expense", archived: false },
    { id: "gammal", parent_id: null, name: "Gammal", kind: "expense", archived: true },
    { id: "inkomst", parent_id: null, name: "Inkomst", kind: "income", archived: false },
    { id: "inkomst-lon", parent_id: "inkomst", name: "Lön", kind: "income", archived: false },
  ],
};

type Call = { method: string; path: string; body: unknown; csrf: string | null };

function api(answer: [number, unknown] = [200, {}], list: [number, unknown] = [200, CATEGORIES]) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://app.test");
      const method = init?.method ?? "GET";
      calls.push({ method, path: url.pathname, body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null, csrf: new Headers(init?.headers).get("x-kronkoll") });
      const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));
      if (method !== "GET") return json(...answer);
      if (url.pathname === "/api/categories") return json(...list);
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
  window.history.replaceState(null, "", "/installningar/kategorier");
  await act(async () => {
    render(<App />);
    await Promise.resolve();
  });
  await settle();
}

const names = (list: string) => within(screen.getByRole("list", { name: list })).getAllByRole("listitem").map((li) => li.querySelector(".tx-name")?.textContent);
const changes = (calls: Call[]) => calls.filter((c) => c.method !== "GET").map(({ method, path, body, csrf }) => ({ method, path, body, csrf }));

async function submit(button: string) {
  fireEvent.click(screen.getByRole("button", { name: button }));
  await settle();
}

describe("kategorier i Inställningar (#34, KK-18-A)", () => {
  it("visar huvudkategorier med sina underkategorier per typ, utan arkiverade", async () => {
    api();
    await open();
    expect(names("Utgifter")).toEqual(["Boende", "Mat", "Livsmedel", "Restaurang"]);
    expect(names("Inkomster")).toEqual(["Inkomst", "Lön"]);
    expect(screen.queryByText("Gammal")).toBeNull();
    // Åtgärderna visas först när raden öppnas, och Stäng döljer dem igen.
    expect(screen.queryByRole("button", { name: "Byt namn på Mat" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ändra Mat" }));
    expect(screen.getByRole("button", { name: "Byt namn på Mat" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stäng" }));
    expect(screen.queryByRole("button", { name: "Byt namn på Mat" })).toBeNull();
    expect(screen.getByRole("link", { name: "‹ Inställningar" }).getAttribute("href")).toBe("/installningar");
  });

  it("byter namn med CSRF-skydd och hämtar listan igen", async () => {
    const calls = api();
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Ändra Livsmedel" }));
    fireEvent.click(screen.getByRole("button", { name: "Byt namn på Livsmedel" }));
    fireEvent.change(screen.getByLabelText("Nytt namn"), { target: { value: "Mat hemma" } });
    await submit("Spara");
    expect(changes(calls)).toEqual([{ method: "PATCH", path: "/api/categories/mat-livsmedel", body: { name: "Mat hemma" }, csrf: "1" }]);
    expect(calls.filter((c) => c.path === "/api/categories" && c.method === "GET")).toHaveLength(2);
    expect(screen.queryByLabelText("Nytt namn")).toBeNull();
  });

  it("lägger till en underkategori och en huvudkategori", async () => {
    const calls = api([201, {}]);
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Ändra Mat" }));
    fireEvent.click(screen.getByRole("button", { name: "Ny underkategori till Mat" }));
    fireEvent.change(screen.getByLabelText("Namn på underkategorin"), { target: { value: "Fika" } });
    await submit("Lägg till");
    fireEvent.click(screen.getByRole("button", { name: "Ny huvudkategori" }));
    fireEvent.change(screen.getByLabelText("Namn på huvudkategorin"), { target: { value: "Husdjur" } });
    await submit("Lägg till");
    expect(changes(calls).map((c) => c.body)).toEqual([{ parent_id: "mat", name: "Fika" }, { parent_id: null, name: "Husdjur" }]);
  });

  it("slår ihop med en kategori på samma nivå och av samma typ", async () => {
    const calls = api();
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Ändra Restaurang" }));
    fireEvent.click(screen.getByRole("button", { name: "Slå ihop Restaurang" }));
    const choice = screen.getByLabelText<HTMLSelectElement>("Slå ihop Restaurang med");
    expect([...choice.options].map((o) => o.textContent)).toEqual(["Livsmedel"]);
    await submit("Slå ihop");
    expect(changes(calls)).toEqual([{ method: "POST", path: "/api/categories/mat-restaurang/merge", body: { into_id: "mat-livsmedel" }, csrf: "1" }]);
  });

  it("säger till när det inte finns någon att slå ihop med", async () => {
    api();
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Ändra Lön" }));
    fireEvent.click(screen.getByRole("button", { name: "Slå ihop Lön" }));
    expect(screen.getByText("Det finns ingen annan kategori på samma nivå att slå ihop med.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Slå ihop" })).toHaveProperty("disabled", true);
  });

  it("arkiverar efter en fråga som förklarar vad som händer, och Avbryt ändrar ingenting", async () => {
    const calls = api();
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Ändra Mat" }));
    fireEvent.click(screen.getByRole("button", { name: "Arkivera Mat" }));
    expect(screen.getByText(/Arkivera Mat och dess underkategorier\? Äldre transaktioner behåller kategorin/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Avbryt" }));
    expect(changes(calls)).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Ändra Mat" }));
    fireEvent.click(screen.getByRole("button", { name: "Arkivera Mat" }));
    fireEvent.click(within(screen.getByRole("form")).getByRole("button", { name: "Arkivera" }));
    await settle();
    expect(changes(calls)).toEqual([{ method: "PATCH", path: "/api/categories/mat", body: { archived: true }, csrf: "1" }]);
  });

  it("visar serverns förklaring när en ändring inte godtas, och ett allmänt fel annars", async () => {
    api([400, { error: "rejected", message: "Det finns redan en kategori som heter Livsmedel" }]);
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Ändra Restaurang" }));
    fireEvent.click(screen.getByRole("button", { name: "Byt namn på Restaurang" }));
    fireEvent.change(screen.getByLabelText("Nytt namn"), { target: { value: "Livsmedel" } });
    await submit("Spara");
    expect(screen.getByRole("alert").textContent).toBe("Det finns redan en kategori som heter Livsmedel");
    cleanup();
    api([503, { error: "unavailable" }]);
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Ändra Restaurang" }));
    fireEvent.click(screen.getByRole("button", { name: "Byt namn på Restaurang" }));
    await submit("Spara");
    expect(screen.getByRole("alert").textContent).toBe("Det gick inte att spara. Försök igen.");
  });

  it("säger till när kategorierna inte går att hämta", async () => {
    api(undefined, [503, { error: "unavailable" }]);
    await open();
    expect(screen.getByRole("alert").textContent).toContain("Det gick inte att hämta kategorierna");
  });

  it("Inställningar länkar hit, och fliken Inställningar är markerad", async () => {
    api();
    await open();
    const tab = within(screen.getByRole("navigation", { name: "Huvudmeny" })).getByRole("link", { name: "Inställningar" });
    expect(tab.getAttribute("aria-current")).toBe("page");
  });
});
