// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.tsx";
import { parsePercent } from "./NewLeave.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

function api(post: [number, unknown] = [201, { id: "l1" }]) {
  const posts: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));
      if (init?.method === "POST") {
        posts.push(JSON.parse(init.body as string) as unknown);
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

async function open(path = "/inkomst/ledighet") {
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

/** Påhittade värden enligt planens exempel (KK-13). */
function fillExample() {
  type("Från", "2027-03-01");
  type("Till", "2027-08-31");
  type("Årsinkomst för SGI (kr)", "540 000");
  type("Föräldralön (% av lön)", "10");
  type("Skattesats (%)", "31,5");
}

async function submit() {
  fireEvent.click(screen.getByRole("button", { name: "Spara" }));
  await settle();
}

describe("Planera föräldraledighet (#40, KK-23)", () => {
  it("öppnas från Inkomst och kan avbrytas", async () => {
    api();
    await open("/inkomst");
    fireEvent.click(screen.getByRole("button", { name: "Planera ledighet" }));
    expect(window.location.pathname).toBe("/inkomst/ledighet");
    expect(screen.getByRole("note").textContent).toBe("Uppskattning – inte ett besked från Försäkringskassan.");
    fireEvent.click(screen.getByRole("button", { name: "Avbryt" }));
    expect(window.location.pathname).toBe("/inkomst");
  });

  it("sparar perioden med uppskattningens underlag, säger till och går tillbaka", async () => {
    const posts = api();
    await open();
    fillExample();
    type("Uttag", "2.5");
    await submit();
    expect(posts).toEqual([
      { from: "2027-03-01", to: "2027-08-31", days_per_week: 2.5, sgi_annual_minor: 54000000, employer_topup_pct: 10, tax_rate_pct: 31.5, override_net_monthly_minor: null },
    ]);
    expect(screen.getByRole("status").textContent).toBe("Ledigheten är planerad.");
    expect(window.location.pathname).toBe("/inkomst");
  });

  it("ett manuellt belopp skickas och används i stället för uppskattningen (KK-23-B)", async () => {
    const posts = api();
    await open();
    fillExample();
    fireEvent.click(screen.getByLabelText("Ange belopp manuellt"));
    expect(screen.getByRole("note").textContent).toContain("Det manuella beloppet används i stället för uppskattningen.");
    type("Manuellt netto per månad (kr)", "21 000");
    await submit();
    expect(posts).toEqual([expect.objectContaining({ days_per_week: 5, override_net_monthly_minor: 2100000 })]);
  });

  it("säger vad som saknas innan något skickas", async () => {
    const posts = api();
    await open();
    const cases: [() => void, string][] = [
      [() => undefined, "Välj start- och slutdatum."],
      [() => { type("Från", "2027-03-01"); type("Till", "2027-08-31"); }, "Skriv årsinkomsten för SGI i kronor, till exempel 540 000."],
      [() => { type("Årsinkomst för SGI (kr)", "540 000"); type("Föräldralön (% av lön)", "tio"); }, "Skriv föräldralönen i procent, 0–100. Skriv 0 om du inte får någon."],
      [() => { type("Föräldralön (% av lön)", "0"); }, "Skriv skattesatsen i procent, till exempel 31,5."],
      [() => { type("Skattesats (%)", "31,5"); fireEvent.click(screen.getByLabelText("Ange belopp manuellt")); }, "Skriv det manuella beloppet i kronor per månad."],
    ];
    for (const [step, message] of cases) {
      step();
      await submit();
      expect(screen.getByRole("alert").textContent).toBe(message);
    }
    expect(posts).toEqual([]);
  });

  it("visar API:ts fel i klartext och stannar kvar", async () => {
    for (const [post, message] of [
      [[422, { error: "to_before_from" }], "Slutdatum måste vara samma dag som eller efter startdatum."],
      [[422, { error: "period_too_long" }], "Planera högst två år i taget. Dela upp längre ledighet i flera perioder."],
      [[503, { error: "unavailable" }], "Det gick inte att spara. Försök igen."],
    ] as [[number, unknown], string][]) {
      api(post);
      await open();
      fillExample();
      await submit();
      expect(screen.getByRole("alert").textContent).toBe(message);
      expect(window.location.pathname).toBe("/inkomst/ledighet");
      cleanup();
    }
  });
});

describe("parsePercent", () => {
  it("läser procent med decimalkomma mellan 0 och 100", () => {
    expect(parsePercent("31,5")).toBe(31.5);
    expect(parsePercent(" 0 ")).toBe(0);
    expect(parsePercent("100")).toBe(100);
    expect(parsePercent("100,5")).toBeNull();
    expect(parsePercent("-1")).toBeNull();
    expect(parsePercent("")).toBeNull();
    expect(parsePercent("3,333")).toBeNull();
  });
});
