// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.tsx";
import { PREVIEW_DELAY_MS } from "./KnownAccountsView.tsx";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const CATEGORIES = { items: [{ id: "privat", parent_id: null, name: "Privat", kind: "expense", archived: false }, { id: "spar", parent_id: null, name: "Sparande", kind: "expense", archived: false }] };
/** Påhittade konton (KK-13). Namnet har HTML i sig, för att visa att det alltid är text (KK-30). */
const ACCOUNTS = { known_accounts: [{ id: "k1", name: "<b>Konto A</b>", match_patterns: ["SWISH TILL A", "ÖVERFÖRING A"], category_id: "privat" }] };

interface Answers {
  list?: [number, unknown];
  put?: [number, unknown];
  del?: number;
  preview?: [number, unknown];
}
type Call = { method: string; path: string; body: unknown };

function api(answers: Answers = {}) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://app.test");
      const method = init?.method ?? "GET";
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      calls.push({ method, path: url.pathname, body });
      const json = (status: number, payload: unknown) => Promise.resolve(new Response(JSON.stringify(payload), { status }));
      if (url.pathname === "/api/categories") return json(200, CATEGORIES);
      if (url.pathname === "/api/known-accounts/preview") return json(...(answers.preview ?? [200, { count: 3 }]));
      if (url.pathname === "/api/known-accounts" && method === "GET") return json(...(answers.list ?? [200, ACCOUNTS]));
      if (method === "PUT") return json(...(answers.put ?? [200, { linked: 2 }]));
      if (method === "DELETE") return Promise.resolve(new Response(null, { status: answers.del ?? 204 }));
      return json(200, {});
    }),
  );
  return calls;
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

async function open() {
  window.history.replaceState(null, "", "/installningar/kanda-konton");
  await act(async () => {
    render(<App />);
    await Promise.resolve();
  });
  await settle();
}

async function wait(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("Kända konton (KK-54-A)", () => {
  it("listar kontona med texter och kategori, som text", async () => {
    api();
    await open();
    const row = within(screen.getByRole("list", { name: "Kända konton" })).getAllByRole("listitem")[0];
    expect(row?.textContent).toContain("<b>Konto A</b>");
    expect(row?.textContent).toContain("SWISH TILL A, ÖVERFÖRING A → Privat");
  });

  it("visar att det är tomt, och att kontona inte gick att hämta", async () => {
    api({ list: [200, { known_accounts: [] }] });
    await open();
    expect(screen.getByText("Inga kända konton")).toBeTruthy();
    cleanup();
    api({ list: [503, {}] });
    await open();
    expect(screen.getByRole("alert").textContent).toBe("Det gick inte att hämta kontona. Försök igen om en stund.");
  });

  it("sparar ett nytt konto med texter och kategori, och säger hur många överföringar som kopplades om", async () => {
    const calls = api({ put: [201, { linked: 2 }] });
    await open();
    fireEvent.click(screen.getAllByRole("button", { name: "Lägg till konto" })[0] as HTMLElement);
    const form = screen.getByRole("form", { name: "Nytt känt konto" });
    fireEvent.change(within(form).getByLabelText("Namn"), { target: { value: "Barnspar" } });
    fireEvent.change(within(form).getByLabelText("Texter i meddelandet"), { target: { value: "barnspar\n\n  sparande barn " } });
    fireEvent.change(within(form).getByLabelText("Standardkategori"), { target: { value: "spar" } });
    fireEvent.click(within(form).getByRole("button", { name: "Spara" }));
    await settle();
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.path).toMatch(/^\/api\/known-accounts\/.+/u);
    expect(put?.body).toEqual({ name: "Barnspar", match_patterns: ["barnspar", "sparande barn"], category_id: "spar" });
    expect(screen.getByRole("status").textContent).toBe("Kontot är sparat. 2 överföringar kopplades om.");
  });

  it("visar antalet träffar medan man skriver, innan något sparas", async () => {
    vi.useFakeTimers();
    const calls = api();
    await open();
    fireEvent.click(within(screen.getByRole("list", { name: "Kända konton" })).getAllByRole("button")[0] as HTMLElement);
    const form = screen.getByRole("form", { name: "Ändra <b>Konto A</b>" });
    fireEvent.change(within(form).getByLabelText("Texter i meddelandet"), { target: { value: "swish till a" } });
    await wait(PREVIEW_DELAY_MS + 10);
    expect(within(form).getByText("3 transaktioner träffar.")).toBeTruthy();
    expect(calls.filter((c) => c.path === "/api/known-accounts/preview").at(-1)?.body).toEqual({ id: "k1", match_patterns: ["swish till a"] });
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("säger när träffarna inte går att räkna, och ingen träff är också ett svar", async () => {
    vi.useFakeTimers();
    api({ preview: [503, {}] });
    await open();
    fireEvent.click(screen.getAllByRole("button", { name: "Lägg till konto" })[0] as HTMLElement);
    const form = screen.getByRole("form", { name: "Nytt känt konto" });
    fireEvent.change(within(form).getByLabelText("Texter i meddelandet"), { target: { value: "x" } });
    await wait(PREVIEW_DELAY_MS + 10);
    expect(within(form).getByText("Det gick inte att räkna träffarna. Du kan ändå spara kontot.")).toBeTruthy();
    cleanup();
    api({ preview: [200, { count: 0 }] });
    await open();
    fireEvent.click(screen.getAllByRole("button", { name: "Lägg till konto" })[0] as HTMLElement);
    const again = screen.getByRole("form", { name: "Nytt känt konto" });
    fireEvent.change(within(again).getByLabelText("Texter i meddelandet"), { target: { value: "x" } });
    await wait(PREVIEW_DELAY_MS + 10);
    expect(within(again).getByText("Inga transaktioner träffar.")).toBeTruthy();
  });

  it("kontrollerar namn, texter och kategori innan det sparas, och visar fel från servern", async () => {
    const calls = api({ put: [500, {}] });
    await open();
    fireEvent.click(screen.getAllByRole("button", { name: "Lägg till konto" })[0] as HTMLElement);
    const form = screen.getByRole("form", { name: "Nytt känt konto" });
    const submit = () => fireEvent.click(within(form).getByRole("button", { name: "Spara" }));
    submit();
    expect(within(form).getByRole("alert").textContent).toBe("Ge kontot ett namn, till exempel Kontot A.");
    fireEvent.change(within(form).getByLabelText("Namn"), { target: { value: "A" } });
    submit();
    expect(within(form).getByRole("alert").textContent).toBe("Skriv minst en text som överföringarna innehåller.");
    fireEvent.change(within(form).getByLabelText("Texter i meddelandet"), { target: { value: "x".repeat(61) } });
    submit();
    expect(within(form).getByRole("alert").textContent).toBe("Skriv högst tio texter, var och en på högst 60 tecken.");
    fireEvent.change(within(form).getByLabelText("Texter i meddelandet"), { target: { value: "swish" } });
    submit();
    expect(within(form).getByRole("alert").textContent).toBe("Välj en kategori.");
    fireEvent.change(within(form).getByLabelText("Standardkategori"), { target: { value: "spar" } });
    submit();
    await settle();
    expect(within(form).getByRole("alert").textContent).toBe("Det gick inte att spara kontot. Försök igen.");
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });

  it("säger att uppgifterna är fel när servern svarar 400", async () => {
    api({ put: [400, {}] });
    await open();
    fireEvent.click(within(screen.getByRole("list", { name: "Kända konton" })).getAllByRole("button")[0] as HTMLElement);
    const form = screen.getByRole("form", { name: "Ändra <b>Konto A</b>" });
    fireEvent.click(within(form).getByRole("button", { name: "Spara" }));
    await settle();
    expect(within(form).getByRole("alert").textContent).toBe("Kontrollera namn, texter och kategori.");
  });

  it("ändrar ett konto och tar bort det efter en fråga", async () => {
    const calls = api({ put: [200, { linked: 0 }] });
    await open();
    fireEvent.click(within(screen.getByRole("list", { name: "Kända konton" })).getAllByRole("button")[0] as HTMLElement);
    let form = screen.getByRole("form", { name: "Ändra <b>Konto A</b>" });
    fireEvent.click(within(form).getByRole("button", { name: "Spara" }));
    await settle();
    expect(calls.find((c) => c.method === "PUT")?.path).toBe("/api/known-accounts/k1");
    expect(screen.getByRole("status").textContent).toBe("Kontot är ändrat.");
    fireEvent.click(within(screen.getByRole("list", { name: "Kända konton" })).getAllByRole("button")[0] as HTMLElement);
    form = screen.getByRole("form", { name: "Ändra <b>Konto A</b>" });
    fireEvent.click(within(form).getByRole("button", { name: "Ta bort" }));
    fireEvent.click(within(form).getByRole("button", { name: "Behåll" }));
    fireEvent.click(within(form).getByRole("button", { name: "Ta bort" }));
    fireEvent.click(within(form).getByRole("button", { name: "Ta bort" }));
    await settle();
    expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/known-accounts/k1")).toBe(true);
    expect(screen.getByRole("status").textContent).toBe("Kontot är borttaget.");
  });

  it("säger till när kontot inte går att ta bort", async () => {
    api({ del: 500 });
    await open();
    fireEvent.click(within(screen.getByRole("list", { name: "Kända konton" })).getAllByRole("button")[0] as HTMLElement);
    const form = screen.getByRole("form", { name: "Ändra <b>Konto A</b>" });
    fireEvent.click(within(form).getByRole("button", { name: "Ta bort" }));
    fireEvent.click(within(form).getByRole("button", { name: "Ta bort" }));
    await settle();
    expect(within(form).getByRole("alert").textContent).toBe("Det gick inte att ta bort kontot. Försök igen.");
  });

  it("finns bland inställningarna", async () => {
    api();
    window.history.replaceState(null, "", "/installningar");
    await act(async () => {
      render(<App />);
      await Promise.resolve();
    });
    expect(screen.getByRole("link", { name: /Kända konton/u }).getAttribute("href")).toBe("/installningar/kanda-konton");
  });
});
