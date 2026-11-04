// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { formatSek } from "@kronkoll/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.tsx";
import { POLL_MS } from "../sync/SyncButton.tsx";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const RULES = { items: [{ id: "r-ikea", match: "counterparty_prefix", pattern: "IKEA", category_id: "hushall", source: "learned", hits: 3, category_archived: false }] };

/** Påhittade träffar (KK-13) i API:ts form. */
function matches(total = 3) {
  return {
    total,
    change: 1,
    unchanged: 1,
    manual: 1,
    items: [
      { id: "k1", transaction_date: "2026-11-02", name: "IKEA KARLSTAD, KARLSTAD", amount_minor: -49900, category_id: null, effect: "change" },
      { id: "k2", transaction_date: "2026-10-20", name: "", amount_minor: -12000, category_id: "hushall", effect: "unchanged" },
      { id: "k3", transaction_date: "2026-10-01", name: "IKEA BARKARBY, JARFALLA", amount_minor: -30000, category_id: "fritid", effect: "manual" },
    ],
  };
}

type Call = { method: string; path: string; body: unknown };

function api(answers: { matches?: [number, unknown]; preview?: [number, unknown]; apply?: [number, unknown]; save?: [number, unknown] } = {}) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://app.test");
      const method = init?.method ?? "GET";
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      calls.push({ method, path: url.pathname, body });
      const json = (status: number, payload: unknown) => Promise.resolve(new Response(JSON.stringify(payload), { status }));
      if (url.pathname === "/api/categories") return json(200, { items: [{ id: "hushall", parent_id: null, name: "Hushåll", kind: "expense", archived: false }] });
      if (url.pathname.endsWith("/matches")) return json(...(answers.matches ?? [200, matches()]));
      if (url.pathname === "/api/rules/apply-all") {
        const preview = typeof body === "object" && body !== null && "preview" in body;
        return json(...(preview ? (answers.preview ?? [200, { would_update: 42 }]) : (answers.apply ?? [200, { updated: 42 }])));
      }
      if (url.pathname === "/api/sync" && method === "POST") return json(202, { status: "started", started_at: "2026-11-15T10:00:00.000Z" });
      if (url.pathname === "/api/sync") return json(200, { started: 1, running: 0, done: true });
      if (method === "POST" && url.pathname === "/api/rules") return json(...(answers.save ?? [201, { rule: { id: "r-ikea" }, retroactive_candidates: 1, protected_manual: 1 }]));
      return json(200, RULES);
    }),
  );
  return calls;
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

async function open() {
  window.history.replaceState(null, "", "/installningar/regler");
  await act(async () => {
    render(<App />);
    await Promise.resolve();
  });
  await settle();
}

const click = async (name: string) => {
  fireEvent.click(screen.getByRole("button", { name }));
  await settle();
};

describe("förhandsvisa regler (#34, KK-18-C)", () => {
  it("Visa träffar listar transaktionerna med vad som händer med var och en", async () => {
    api();
    await open();
    await click("Ändra regeln IKEA");
    await click("Visa träffar");
    expect(screen.getByText("3 träffar: 1 får kategorin, 1 manuellt valda ändras inte.")).toBeTruthy();
    const rows = within(screen.getByRole("list", { name: "Träffar" })).getAllByRole("listitem");
    expect(rows.map((r) => r.querySelector(".tx-notes")?.textContent.split(" · ").at(1))).toEqual(["Får kategorin", "Har redan kategorin", "Manuellt vald, ändras inte"]);
    expect(rows[0]?.textContent).toContain(formatSek(-49900));
    expect(rows[1]?.querySelector(".tx-name")?.textContent).toBe("Okänd motpart");
    await click("Stäng");
    expect(screen.queryByRole("list", { name: "Träffar" })).toBeNull();
  });

  it("säger hur många som visas när det finns fler, och när regeln inte träffar något", async () => {
    api({ matches: [200, matches(250)] });
    await open();
    await click("Ändra regeln IKEA");
    await click("Visa träffar");
    expect(screen.getByText(/Visar de 3 senaste\./u)).toBeTruthy();
    cleanup();
    api({ matches: [200, { total: 0, change: 0, unchanged: 0, manual: 0, items: [] }] });
    await open();
    await click("Ändra regeln IKEA");
    await click("Visa träffar");
    expect(screen.getByText("Regeln träffar inga transaktioner än.")).toBeTruthy();
  });

  it("frågan efter en ny regel visar träffarna innan man applicerar", async () => {
    api();
    await open();
    await click("Ny regel");
    fireEvent.change(screen.getByLabelText("Allt som börjar med"), { target: { value: "ikea" } });
    fireEvent.change(screen.getByLabelText("Får kategorin"), { target: { value: "hushall" } });
    await click("Spara");
    expect(screen.getByText(/Regeln matchar 1 tidigare transaktioner/u)).toBeTruthy();
    expect(screen.getByRole("list", { name: "Träffar" })).toBeTruthy();
  });

  it("säger till när träffarna inte går att hämta", async () => {
    api({ matches: [503, {}] });
    await open();
    await click("Ändra regeln IKEA");
    await click("Visa träffar");
    expect(screen.getByRole("alert").textContent).toBe("Det gick inte att hämta träffarna.");
  });
});

describe("applicera alla regler (#34, KK-18-C)", () => {
  it("räknar först, frågar, och applicerar på ja", async () => {
    const calls = api();
    await open();
    await click("Applicera alla regler");
    expect(screen.getByText(/42 transaktioner får ny kategori enligt reglerna/u)).toBeTruthy();
    await click("Applicera");
    expect(calls.filter((c) => c.path === "/api/rules/apply-all").map((c) => c.body)).toEqual([{ preview: true }, {}]);
    expect(screen.getByRole("status").textContent).toBe("42 transaktioner fick ny kategori.");
  });

  it("Avbryt ändrar ingenting, och utan något att ändra frågar den inte", async () => {
    const calls = api();
    await open();
    await click("Applicera alla regler");
    await click("Avbryt");
    expect(calls.filter((c) => c.path === "/api/rules/apply-all")).toHaveLength(1);
    cleanup();
    api({ preview: [200, { would_update: 0 }] });
    await open();
    await click("Applicera alla regler");
    expect(screen.getByRole("status").textContent).toBe("Alla transaktioner har redan kategorin som reglerna ger.");
  });

  it("säger till när räkningen eller appliceringen misslyckas", async () => {
    api({ preview: [503, {}] });
    await open();
    await click("Applicera alla regler");
    expect(screen.getByRole("alert").textContent).toBe("Det gick inte att räkna. Försök igen.");
    cleanup();
    api({ apply: [503, {}] });
    await open();
    await click("Applicera alla regler");
    await click("Applicera");
    expect(screen.getByRole("alert").textContent).toBe("Det gick inte att applicera reglerna. Försök igen.");
  });

  it("Synka nu finns på sidan och hämtar reglerna igen när synken är klar", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = api();
    await open();
    const before = calls.filter((c) => c.method === "GET" && c.path === "/api/rules").length;
    await click("Synka nu");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    });
    await settle();
    expect(calls.filter((c) => c.method === "GET" && c.path === "/api/rules").length).toBeGreaterThan(before);
  });
});
