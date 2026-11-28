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

async function open(path = "/installningar/kategorier") {
  window.history.replaceState(null, "", path);
  await act(async () => {
    render(<App />);
    await Promise.resolve();
  });
  await settle();
}

const rows = (list: string) => within(screen.getByRole("list", { name: list })).getAllByRole("listitem").map((li) => li.querySelector(".ui-row-label")?.textContent);
const changes = (calls: Call[]) => calls.filter((c) => c.method !== "GET").map(({ method, path, body, csrf }) => ({ method, path, body, csrf }));
const sheet = () => within(screen.getByRole("dialog"));

async function submit(button: string) {
  fireEvent.click(sheet().getByRole("button", { name: button }));
  await settle();
}

/** Öppnar arket för en underkategori i Mat och väljer en åtgärd. */
async function action(name: string, choice: string) {
  await open("/installningar/kategorier/mat");
  fireEvent.click(screen.getByRole("button", { name }));
  fireEvent.click(sheet().getByRole("button", { name: choice }));
}

describe("kategorier i Inställningar (#251, KK-18-A)", () => {
  it("visar huvudkategorierna per typ med antal underkategorier, utan arkiverade, och länkar till undervyn", async () => {
    api();
    await open();
    expect(rows("Utgifter")).toEqual(["Boende", "Mat"]);
    expect(rows("Inkomster")).toEqual(["Inkomst"]);
    expect(screen.queryByText("Gammal")).toBeNull();
    const mat = screen.getByRole("link", { name: /Mat/u });
    expect(mat.textContent).toContain("2 underkategorier");
    expect(mat.getAttribute("href")).toBe("/installningar/kategorier/mat");
    expect(screen.getByRole("link", { name: /Boende/u }).textContent).toContain("Inga underkategorier");
    // Färgen är bara en ledtråd och döljs för skärmläsare (KK-26-D).
    expect(mat.querySelector(".cat-dot")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("undervyn visar underkategorierna, och ett tryck öppnar ett ark med åtgärderna", async () => {
    api();
    await open("/installningar/kategorier/mat");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Mat");
    expect(rows("Underkategorier")).toEqual(["Livsmedel", "Restaurang"]);
    fireEvent.click(screen.getByRole("button", { name: "Livsmedel" }));
    expect(rows("Åtgärder för Livsmedel")).toEqual(["Flytta ner", "Byt namn", "Slå ihop med en annan", "Arkivera"]);
    fireEvent.click(sheet().getByRole("button", { name: "Stäng" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    // Huvudkategorin ändras med knappen i sidhuvudet, och kan få underkategorier.
    fireEvent.click(screen.getByRole("button", { name: "Ändra Mat" }));
    expect(rows("Åtgärder för Mat")).toEqual(["Flytta upp", "Byt namn", "Ny underkategori", "Slå ihop med en annan", "Arkivera"]);
  });

  it("byter namn med CSRF-skydd och hämtar listan igen", async () => {
    const calls = api();
    await action("Livsmedel", "Byt namn");
    const input = sheet().getByLabelText("Nytt namn");
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "Mat hemma" } });
    await submit("Spara");
    expect(changes(calls)).toEqual([{ method: "PATCH", path: "/api/categories/mat-livsmedel", body: { name: "Mat hemma" }, csrf: "1" }]);
    expect(calls.filter((c) => c.path === "/api/categories" && c.method === "GET")).toHaveLength(2);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("lägger till en underkategori och en huvudkategori", async () => {
    const calls = api([201, {}]);
    await open("/installningar/kategorier/mat");
    fireEvent.click(screen.getByRole("button", { name: "Ny underkategori" }));
    fireEvent.change(sheet().getByLabelText("Namn på underkategorin"), { target: { value: "Fika" } });
    await submit("Lägg till");
    cleanup();
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Ny huvudkategori" }));
    fireEvent.change(sheet().getByLabelText("Namn på huvudkategorin"), { target: { value: "Husdjur" } });
    await submit("Lägg till");
    expect(changes(calls).map((c) => c.body)).toEqual([{ parent_id: "mat", name: "Fika" }, { parent_id: null, name: "Husdjur" }]);
  });

  it("slår ihop med en kategori på samma nivå och av samma typ", async () => {
    const calls = api();
    await action("Restaurang", "Slå ihop med en annan");
    const choice = sheet().getByLabelText<HTMLSelectElement>("Slå ihop Restaurang med");
    expect([...choice.options].map((o) => o.textContent)).toEqual(["Livsmedel"]);
    await submit("Slå ihop");
    expect(changes(calls)).toEqual([{ method: "POST", path: "/api/categories/mat-restaurang/merge", body: { into_id: "mat-livsmedel" }, csrf: "1" }]);
  });

  it("säger till när det inte finns någon att slå ihop med", async () => {
    api();
    await open("/installningar/kategorier/inkomst");
    fireEvent.click(screen.getByRole("button", { name: "Lön" }));
    fireEvent.click(sheet().getByRole("button", { name: "Slå ihop med en annan" }));
    expect(sheet().getByText("Det finns ingen annan kategori på samma nivå att slå ihop med.")).toBeTruthy();
    expect(sheet().getByRole("button", { name: "Slå ihop" })).toHaveProperty("disabled", true);
  });

  it("arkiverar efter en förklaring, och Avbryt ändrar ingenting", async () => {
    const calls = api();
    await open("/installningar/kategorier/mat");
    fireEvent.click(screen.getByRole("button", { name: "Ändra Mat" }));
    fireEvent.click(sheet().getByRole("button", { name: "Arkivera" }));
    expect(sheet().getByText(/Mat och dess underkategorier går inte att välja längre\. Äldre transaktioner behåller kategorin/u)).toBeTruthy();
    fireEvent.click(sheet().getByRole("button", { name: "Avbryt" }));
    expect(changes(calls)).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Ändra Mat" }));
    fireEvent.click(sheet().getByRole("button", { name: "Arkivera" }));
    await submit("Arkivera");
    expect(changes(calls)).toEqual([{ method: "PATCH", path: "/api/categories/mat", body: { archived: true }, csrf: "1" }]);
    expect(screen.getByRole("status").textContent).toBe("Mat är arkiverad.");
  });

  it("en huvudkategori som inte finns säger det", async () => {
    api();
    await open("/installningar/kategorier/gammal");
    expect(screen.getByText("Kategorin finns inte")).toBeTruthy();
  });

  it("visar serverns förklaring vid fältet när en ändring inte godtas, och ett allmänt fel annars", async () => {
    api([400, { error: "rejected", message: "Det finns redan en kategori som heter Livsmedel" }]);
    await action("Restaurang", "Byt namn");
    fireEvent.change(sheet().getByLabelText("Nytt namn"), { target: { value: "Livsmedel" } });
    await submit("Spara");
    expect(sheet().getByRole("alert").textContent).toBe("Det finns redan en kategori som heter Livsmedel");
    cleanup();
    api([503, { error: "unavailable" }]);
    await action("Restaurang", "Byt namn");
    await submit("Spara");
    expect(sheet().getByRole("alert").textContent).toBe("Det gick inte att spara. Försök igen.");
  });

  it("säger till när kategorierna inte går att hämta", async () => {
    api(undefined, [503, { error: "unavailable" }]);
    await open();
    expect(screen.getByRole("alert").textContent).toContain("Det gick inte att hämta kategorierna");
  });

  it("Översikt är markerad i menyn eftersom Inställningar nås därifrån", async () => {
    api();
    await open("/installningar/kategorier/mat");
    const tab = within(screen.getByRole("navigation", { name: "Huvudmeny" })).getByRole("link", { name: "Översikt" });
    expect(tab.getAttribute("aria-current")).toBe("page");
  });
});

describe("flytta kategorier upp och ner (#251, KK-18-A)", () => {
  /** Mat har tre underkategorier. Platser finns bara när ett test ger dem. */
  const list = (places: Record<string, number> = {}) => ({
    items: [
      { id: "mat", parent_id: null, name: "Mat", kind: "expense", archived: false, position: places["mat"] ?? null },
      { id: "boende", parent_id: null, name: "Boende", kind: "expense", archived: false, position: places["boende"] ?? null },
      { id: "mat-livsmedel", parent_id: "mat", name: "Livsmedel", kind: "expense", archived: false, position: places["mat-livsmedel"] ?? null },
      { id: "mat-restaurang", parent_id: "mat", name: "Restaurang", kind: "expense", archived: false, position: places["mat-restaurang"] ?? null },
      { id: "mat-systembolaget", parent_id: "mat", name: "Systembolaget", kind: "expense", archived: false, position: places["mat-systembolaget"] ?? null },
    ],
  });
  const rowsOf = (name: string) => within(sheet().getByRole("list", { name })).getAllByRole("listitem").map((li) => li.textContent);

  it("visar listorna i den ordning platserna ger, och på namn för dem som saknar plats", async () => {
    api([200, {}], [200, list({ "mat-systembolaget": 0, "mat-livsmedel": 1 })]);
    await open("/installningar/kategorier/mat");
    expect(rows("Underkategorier")).toEqual(["Systembolaget", "Livsmedel", "Restaurang"]);
    cleanup();
    api([200, {}], [200, list({ mat: 0, boende: 1 })]);
    await open();
    expect(rows("Utgifter")).toEqual(["Mat", "Boende"]);
  });

  it("säger vilken plats kategorin har, och erbjuder bara de flyttar som går", async () => {
    api([200, {}], [200, list()]);
    await open("/installningar/kategorier/mat");
    fireEvent.click(screen.getByRole("button", { name: "Restaurang" }));
    expect(sheet().getByRole("status").textContent).toBe("Plats 2 av 3");
    expect(rowsOf("Åtgärder för Restaurang").slice(0, 2)).toEqual(["Flytta upp", "Flytta ner"]);
    fireEvent.click(sheet().getByRole("button", { name: "Stäng" }));
    fireEvent.click(screen.getByRole("button", { name: "Livsmedel" }));
    expect(sheet().getByRole("status").textContent).toBe("Plats 1 av 3");
    expect(sheet().queryByRole("button", { name: "Flytta upp" })).toBeNull();
    expect(sheet().getByRole("button", { name: "Flytta ner" })).toBeTruthy();
    fireEvent.click(sheet().getByRole("button", { name: "Stäng" }));
    fireEvent.click(screen.getByRole("button", { name: "Systembolaget" }));
    expect(sheet().queryByRole("button", { name: "Flytta ner" })).toBeNull();
    expect(sheet().getByRole("button", { name: "Flytta upp" })).toBeTruthy();
  });

  it("flytta upp ber servern flytta före den som står före, lämnar arket öppet och hämtar listan igen", async () => {
    const calls = api([200, {}], [200, list()]);
    await open("/installningar/kategorier/mat");
    fireEvent.click(screen.getByRole("button", { name: "Restaurang" }));
    await submit("Flytta upp");
    expect(changes(calls)).toEqual([{ method: "POST", path: "/api/categories/mat-restaurang/move", body: { before_id: "mat-livsmedel" }, csrf: "1" }]);
    expect(calls.filter((c) => c.path === "/api/categories" && c.method === "GET")).toHaveLength(2);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("flytta ner ber servern flytta före den näst efter, eller sist när det inte finns någon", async () => {
    const calls = api([200, {}], [200, list()]);
    await open("/installningar/kategorier/mat");
    fireEvent.click(screen.getByRole("button", { name: "Livsmedel" }));
    await submit("Flytta ner");
    fireEvent.click(sheet().getByRole("button", { name: "Stäng" }));
    fireEvent.click(screen.getByRole("button", { name: "Restaurang" }));
    await submit("Flytta ner");
    expect(changes(calls).map((c) => [c.path, c.body])).toEqual([
      ["/api/categories/mat-livsmedel/move", { before_id: "mat-systembolaget" }],
      ["/api/categories/mat-restaurang/move", { before_id: null }],
    ]);
  });

  it("en huvudkategori flyttas bland huvudkategorierna av samma typ", async () => {
    const calls = api([200, {}], [200, list()]);
    await open("/installningar/kategorier/mat");
    fireEvent.click(screen.getByRole("button", { name: "Ändra Mat" }));
    expect(sheet().getByRole("status").textContent).toBe("Plats 2 av 2");
    await submit("Flytta upp");
    expect(changes(calls).map((c) => [c.path, c.body])).toEqual([["/api/categories/mat/move", { before_id: "boende" }]]);
  });

  it("visar serverns förklaring i arket när flytten inte godtas, och arket är kvar", async () => {
    api([400, { error: "rejected", message: "Kategorin är arkiverad" }], [200, list()]);
    await open("/installningar/kategorier/mat");
    fireEvent.click(screen.getByRole("button", { name: "Restaurang" }));
    await submit("Flytta upp");
    expect(sheet().getByRole("alert").textContent).toBe("Kategorin är arkiverad");
    expect(sheet().getByRole("button", { name: "Flytta upp" })).toBeTruthy();
  });
});
