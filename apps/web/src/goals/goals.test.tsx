// @vitest-environment jsdom
import { formatSek } from "@kronkoll/domain";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.tsx";
import { toGoal } from "./goals.ts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

/** Påhittade sparmål i samma form som GET /api/goals (KK-13). */
const goal = (id: string, name: string, saved: number, target: number, forecast: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id, name, target_minor: target, target_date: "2027-08-31", source: "manual", account_id: null, account_missing: false,
  saved_minor: saved, monthly_rate_minor: 320000, contributions: [], forecast, ...extra,
});

const GOALS = [
  goal("g1", "Resa till Japan", 2150000, 6000000, { kind: "eta", reach_period: "2027-12", months_left: 13, on_track: false, months_late: 4, required_monthly_minor: 427778 }),
  goal("g2", "Buffert", 7400000, 10000000, { kind: "eta", reach_period: "2027-08", months_left: 9, on_track: true, months_late: 0, required_monthly_minor: 200000 }),
  goal("g3", "Ny barnvagn", 120000, 800000, { kind: "never", required_monthly_minor: 170000 }),
  goal("g4", "Cykel", 900000, 800000, { kind: "reached", remaining_minor: 0 }),
  goal("g5", "Sommarstuga", 0, 5000000, { kind: "eta", reach_period: "2030-06", months_left: 43, on_track: null, months_late: null, required_monthly_minor: null }, { target_date: null }),
  goal("g6", "Bil", 0, 5000000, { kind: "never", required_monthly_minor: null }, { source: "account", account_missing: true }),
];

function api(status = 200, body: unknown = { items: GOALS }) {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status }))));
}

async function open() {
  window.history.replaceState(null, "", "/sparmal");
  await act(async () => {
    render(<App />);
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
}

const row = (name: string) => within(screen.getByRole("list", { name: "Dina sparmål" })).getByText(name).closest("li") as HTMLElement;

describe("Sparmål (#39, KK-21)", () => {
  it("visar sparat av målet, prognosen och status mot måldatumet (KK-21-A)", async () => {
    api();
    await open();
    expect(screen.getByRole("heading", { name: "Sparmål" })).toBeTruthy();
    expect(row("Resa till Japan").textContent).toContain(`${formatSek(2150000)} av ${formatSek(6000000)} · prognos dec. 2027`);
    expect(within(row("Resa till Japan")).getByText("4 mån sen").className).toBe("badge warn");
    expect(within(row("Buffert")).getByText("I fas").className).toBe("badge ok");
    expect(row("Sommarstuga").textContent).toContain("prognos juni 2030");
    expect(row("Sommarstuga").querySelector(".badge")).toBeNull();
  });

  it("utan sparttakt står det i stället för ett datum (KK-21-B), och nådda mål och saknade konton syns", async () => {
    api();
    await open();
    expect(within(row("Ny barnvagn")).getByText("Nås inte i nuvarande takt").className).toBe("badge bad");
    expect(row("Ny barnvagn").textContent).not.toContain("prognos");
    expect(within(row("Cykel")).getByText("Nått").className).toBe("badge ok");
    expect(within(row("Bil")).getByText("Kopplat konto saknas").className).toBe("badge bad");
  });

  it("stapeln visar andelen sparat och fylls inte över 100 %", async () => {
    api();
    await open();
    expect(row("Resa till Japan").querySelector("progress")?.getAttribute("value")).toBe("35");
    expect(row("Cykel").querySelector("progress")?.getAttribute("value")).toBe("100");
  });

  it("utan mål visas en uppmaning, och fel vid hämtning syns som fel", async () => {
    api(200, { items: [] });
    await open();
    expect(screen.getByRole("main").textContent).toContain("Inga sparmål än.");
    cleanup();
    api(503, { error: "unavailable" });
    await open();
    expect(screen.getByRole("alert").textContent).toBe("Det gick inte att hämta sparmålen. Försök igen om en stund.");
  });

  it("Sparmål finns i huvudmenyn och är markerad", async () => {
    api();
    await open();
    expect(within(screen.getByRole("navigation", { name: "Huvudmeny" })).getByRole("link", { name: "Sparmål" }).getAttribute("aria-current")).toBe("page");
  });

  it("tål svar med saknade eller felaktiga fält", () => {
    expect(toGoal({ name: "Utan id" })).toBeNull();
    expect(toGoal({ id: "x", name: "Konstigt", forecast: { kind: "eta" } })).toMatchObject({ targetMinor: 0, targetDate: null, source: "manual", forecast: { kind: "never", requiredMonthlyMinor: null } });
    expect(toGoal({ id: "x", name: "Gammal", forecast: { kind: "eta", reach_period: "2027-01", on_track: "ja" } })?.forecast).toEqual({
      kind: "eta", reachPeriod: "2027-01", monthsLeft: 0, onTrack: null, monthsLate: null, requiredMonthlyMinor: null,
    });
  });
});
