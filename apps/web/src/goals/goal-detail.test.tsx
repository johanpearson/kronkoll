// @vitest-environment jsdom
import { formatSek } from "@kronkoll/domain";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

/** Påhittade sparmål i samma form som GET /api/goals/{id} (KK-13). */
const JAPAN = {
  id: "g1", name: "Resa till Japan", target_minor: 6000000, target_date: "2027-08-31", source: "manual", account_id: null, account_missing: false,
  saved_minor: 2150000, monthly_rate_minor: 320000,
  forecast: { kind: "eta", reach_period: "2027-12", months_left: 13, on_track: false, months_late: 4, required_monthly_minor: 427778 },
  contributions: [{ date: "2026-10-28", amount_minor: 300000 }, { date: "2026-09-27", amount_minor: -50000 }],
};

function api(goal: [number, unknown] = [200, JAPAN], post: [number, unknown] = [201, { ...JAPAN, saved_minor: 2450000, contributions: [{ date: "2026-11-04", amount_minor: 300000 }, ...JAPAN.contributions] }]) {
  const posts: { path: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://app.test");
      const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));
      if (init?.method === "POST") {
        posts.push({ path: url.pathname, body: JSON.parse(init.body as string) as unknown });
        return json(...post);
      }
      if (url.pathname === "/api/goals") return json(200, { items: [JAPAN] });
      return json(...goal);
    }),
  );
  return posts;
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
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

const main = () => screen.getByRole("main").textContent;
const values = () => screen.getAllByRole("definition").map((d) => d.textContent);

describe("ett sparmåls sida (#39, KK-21)", () => {
  it("öppnas från listan och visar sparat, prognos, måldatum, takt och vad som krävs (KK-21-A)", async () => {
    api();
    await open("/sparmal");
    fireEvent.click(screen.getByRole("link", { name: "Resa till Japan" }));
    await settle();
    expect(window.location.pathname).toBe("/sparmal/g1");
    expect(screen.getByRole("heading", { level: 1, name: "Resa till Japan" })).toBeTruthy();
    expect(main()).toContain(`${formatSek(2150000)} av ${formatSek(6000000)} (35 %)`);
    expect(screen.getByText("4 mån sen").className).toBe("badge warn");
    expect(values()).toEqual(["dec. 2027", "aug. 2027", `${formatSek(320000)}/mån`]);
    expect(screen.getByRole("note").textContent).toBe(`För att nå målet till augusti 2027 behövs ${formatSek(427778)}/mån (nu ${formatSek(320000)}/mån).`);
    const rows = within(screen.getByRole("list", { name: "Avsättningar" })).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual([`Avsättning${formatSek(300000)}28 okt. 2026`, `Uttag${formatSek(-50000)}27 sep. 2026`]);
  });

  it("utan sparttakt står det i stället för ett datum, med vad som krävs (KK-21-B)", async () => {
    api([200, { ...JAPAN, target_date: "2027-03-31", monthly_rate_minor: 0, contributions: [], forecast: { kind: "never", required_monthly_minor: 170000 } }]);
    await open();
    expect(values()[0]).toBe("Nås inte");
    expect(screen.getAllByRole("note").map((n) => n.textContent)).toEqual([
      "Nås inte i nuvarande takt – inget sparat de senaste 3 månaderna.",
      `För att nå målet till mars 2027 behövs ${formatSek(170000)}/mån.`,
    ]);
    expect(main()).toContain("Inga avsättningar än.");
  });

  it("i fas, nått eller utan måldatum ger inga råd", async () => {
    for (const goal of [
      { ...JAPAN, forecast: { ...JAPAN.forecast, on_track: true, months_late: 0 } },
      { ...JAPAN, forecast: { kind: "reached", remaining_minor: 0 } },
      { ...JAPAN, target_date: null, forecast: { ...JAPAN.forecast, on_track: null, months_late: null, required_monthly_minor: null } },
    ]) {
      api([200, goal]);
      await open();
      expect(screen.queryByRole("note")).toBeNull();
      cleanup();
    }
    api([200, { ...JAPAN, target_date: null, forecast: { kind: "reached", remaining_minor: 0 } }]);
    await open();
    expect(values()).toEqual(["Nått", "Inget", `${formatSek(320000)}/mån`]);
  });

  it("ett mål som följer ett konto har inga egna avsättningar, och ett försvunnet konto syns", async () => {
    api([200, { ...JAPAN, source: "account", account_id: "acc_spar", contributions: [] }]);
    await open();
    expect(main()).toContain("Saldot på kontot räknas som sparat.");
    expect(screen.queryByRole("form", { name: "Ny avsättning" })).toBeNull();
    cleanup();
    api([200, { ...JAPAN, source: "account", account_id: null, account_missing: true, contributions: [], forecast: { kind: "never", required_monthly_minor: null } }]);
    await open();
    expect(screen.getByRole("alert").textContent).toBe("Kontot som målet följde finns inte längre, så inget räknas som sparat.");
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("lägger till en avsättning eller ett uttag och visar det nya läget direkt", async () => {
    const posts = api();
    await open();
    const form = screen.getByRole("form", { name: "Ny avsättning" });
    fireEvent.change(within(form).getByLabelText("Belopp (kr)"), { target: { value: "3 000" } });
    fireEvent.click(within(form).getByRole("button", { name: "Lägg till" }));
    await settle();
    expect(screen.getByRole("status").textContent).toBe("Avsättningen är sparad.");
    expect(main()).toContain(`${formatSek(2450000)} av`);
    fireEvent.change(within(form).getByLabelText("Belopp (kr)"), { target: { value: "500" } });
    fireEvent.click(within(form).getByLabelText("Det är ett uttag"));
    fireEvent.click(within(form).getByRole("button", { name: "Lägg till" }));
    await settle();
    expect(screen.getByRole("status").textContent).toBe("Uttaget är sparat.");
    expect(posts).toEqual([
      { path: "/api/goals/g1/contributions", body: { amount_minor: 300000 } },
      { path: "/api/goals/g1/contributions", body: { amount_minor: -50000 } },
    ]);
  });

  it("säger till om beloppet är fel eller API:t säger nej", async () => {
    for (const [post, input, message] of [
      [[201, JAPAN], "noll", "Skriv beloppet i kronor, till exempel 3 000."],
      [[201, JAPAN], "0", "Skriv beloppet i kronor, till exempel 3 000."],
      [[409, { error: "goal_uses_account" }], "100", "Målet följer ett kontos saldo och har inga egna avsättningar."],
      [[503, { error: "unavailable" }], "100", "Det gick inte att spara. Försök igen."],
    ] as [[number, unknown], string, string][]) {
      api(undefined, post);
      await open();
      fireEvent.change(screen.getByLabelText("Belopp (kr)"), { target: { value: input } });
      fireEvent.click(screen.getByRole("button", { name: "Lägg till" }));
      await settle();
      expect(screen.getByRole("alert").textContent).toBe(message);
      cleanup();
    }
  });

  it("ett mål som inte finns eller inte går att hämta", async () => {
    api([404, { error: "not_found" }]);
    await open();
    expect(screen.getByRole("alert").textContent).toBe("Sparmålet finns inte.");
    cleanup();
    api([503, { error: "unavailable" }]);
    await open();
    expect(screen.getByRole("alert").textContent).toBe("Det gick inte att hämta sparmålet. Försök igen om en stund.");
    expect(screen.getByRole("link", { name: "‹ Sparmål" }).getAttribute("href")).toBe("/sparmal");
  });
});
