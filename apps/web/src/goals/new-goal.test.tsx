// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.tsx";
import { parseKronor } from "./NewGoal.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

/** Påhittade konton (KK-13). */
const ACCOUNTS = { items: [{ id: "acc_spar", name: "Sparkonto ••7712" }, { id: "acc_1", name: "Vardag" }] };

function api(post: [number, unknown] = [201, { id: "g1" }], accounts: unknown = ACCOUNTS) {
  const posts: { body: unknown; csrf: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://app.test");
      const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));
      if (url.pathname === "/api/accounts") return json(200, accounts);
      if (init?.method === "POST") {
        posts.push({ body: JSON.parse(init.body as string) as unknown, csrf: new Headers(init.headers).get("x-kronkoll") });
        return json(...post);
      }
      return json(200, { items: [] });
    }),
  );
  return posts;
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
}

async function open(path = "/sparmal/nytt") {
  window.history.replaceState(null, "", path);
  await act(async () => {
    render(<App />);
    await Promise.resolve();
  });
  await settle();
}

const type = (label: string, value: string) => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};

async function submit() {
  fireEvent.click(screen.getByRole("button", { name: "Skapa sparmål" }));
  await settle();
}

describe("Nytt sparmål (#39, KK-21)", () => {
  it("öppnas från listan och kan avbrytas", async () => {
    api();
    await open("/sparmal");
    fireEvent.click(screen.getByRole("button", { name: "Nytt sparmål" }));
    await settle();
    expect(window.location.pathname).toBe("/sparmal/nytt");
    fireEvent.click(screen.getByRole("button", { name: "Avbryt" }));
    expect(window.location.pathname).toBe("/sparmal");
  });

  it("sparar ett mål med egna avsättningar, säger till och går tillbaka till listan", async () => {
    const posts = api();
    await open();
    type("Namn", "  Resa till Japan ");
    type("Målbelopp (kr)", "60 000");
    type("Måldatum (valfritt)", "2027-08-31");
    type("Redan sparat (kr)", "21 500,50");
    await submit();
    expect(posts).toEqual([
      { body: { name: "Resa till Japan", target_minor: 6000000, target_date: "2027-08-31", source: { type: "manual", initial_minor: 2150050 } }, csrf: "1" },
    ]);
    expect(screen.getByRole("status").textContent).toBe("Sparmålet är skapat.");
    expect(window.location.pathname).toBe("/sparmal");
  });

  it("sparar ett mål som bygger på ett kontos saldo, utan måldatum", async () => {
    const posts = api();
    await open();
    type("Namn", "Buffert");
    type("Målbelopp (kr)", "100000");
    fireEvent.click(screen.getByLabelText("Ett konto (saldot räknas)"));
    type("Konto", "acc_spar");
    await submit();
    expect(posts[0]?.body).toEqual({ name: "Buffert", target_minor: 10000000, target_date: null, source: { type: "account", account_id: "acc_spar" } });
  });

  it("säger vad som saknas innan något skickas", async () => {
    const posts = api();
    await open();
    const cases: [() => void, string][] = [
      [() => { type("Namn", " "); }, "Ge målet ett namn."],
      [() => { type("Namn", "Resa"); type("Målbelopp (kr)", "mycket"); }, "Skriv målbeloppet i kronor, till exempel 60 000."],
      [() => { type("Målbelopp (kr)", "0"); }, "Skriv målbeloppet i kronor, till exempel 60 000."],
      [() => { type("Målbelopp (kr)", "60 000"); type("Redan sparat (kr)", "-5"); }, "Skriv det som redan är sparat i kronor, eller lämna fältet tomt."],
      [() => { fireEvent.click(screen.getByLabelText("Ett konto (saldot räknas)")); }, "Välj vilket konto som sparar till målet."],
    ];
    for (const [step, message] of cases) {
      step();
      await submit();
      expect(screen.getByRole("alert").textContent).toBe(message);
    }
    expect(posts).toEqual([]);
  });

  it("visar API:ts fel i klartext och stannar kvar i formuläret", async () => {
    for (const [post, message] of [
      [[422, { error: "target_date_in_past" }], "Måldatum måste ligga efter i dag."],
      [[400, { error: "unknown_account" }], "Kontot finns inte längre. Välj ett annat."],
      [[503, { error: "unavailable" }], "Det gick inte att spara målet. Försök igen."],
    ] as [[number, unknown], string][]) {
      api(post);
      await open();
      type("Namn", "Resa");
      type("Målbelopp (kr)", "100");
      await submit();
      expect(screen.getByRole("alert").textContent).toBe(message);
      expect(window.location.pathname).toBe("/sparmal/nytt");
      cleanup();
    }
  });

  it("utan konton går det bara att spara med egna avsättningar", async () => {
    api(undefined, { error: "unavailable" });
    await open();
    expect(screen.getByLabelText<HTMLInputElement>("Ett konto (saldot räknas)").disabled).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>("Egna avsättningar").checked).toBe(true);
  });
});

describe("parseKronor", () => {
  it("läser kronor med mellanslag, hårt mellanslag och decimalkomma", () => {
    expect(parseKronor("60 000")).toBe(6000000);
    expect(parseKronor("1\u00a0234,5")).toBe(123450);
    expect(parseKronor("")).toBe(0);
    expect(parseKronor("-1")).toBeNull();
    expect(parseKronor("tio")).toBeNull();
  });
});
