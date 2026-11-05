// @vitest-environment jsdom
import { formatDateShort, formatSek } from "@kronkoll/domain";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.tsx";
import { effectText } from "./leave-effect.ts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

/** Påhittat mål och påhittad ledighet (KK-13). */
const GOAL = {
  id: "g1", name: "Resa till Japan", target_minor: 6000000, target_date: null, source: "manual", account_id: null, account_missing: false,
  saved_minor: 2150000, monthly_rate_minor: 320000, contributions: [],
  forecast: { kind: "eta", reach_period: "2027-12", months_left: 13, on_track: null, months_late: null, required_monthly_minor: null },
};
const impact = (goalId: string, extra: Record<string, unknown> = {}) => ({
  type: "goal", goal_id: goalId, name: "x", lost_saving_minor: 840000, delay_months: 3, reach_period_before: "2027-12", reach_period_after: "2028-03",
  on_track_before: null, on_track_after: null, ...extra,
});
const PERIOD = {
  id: "l1", from: "2027-03-01", to: "2027-08-31",
  impacts: [{ type: "budget", period: "2027-03", shortfall_minor: 1 }, impact("g1"), impact("g2", { delay_months: 9 })],
};

function api(leave: [number, unknown]) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://app.test");
      const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));
      return url.pathname === "/api/leave-periods" ? json(...leave) : json(200, GOAL);
    }),
  );
}

async function open() {
  window.history.replaceState(null, "", "/sparmal/g1");
  await act(async () => {
    render(<App />);
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

const leave = `Med ledighet ${formatDateShort("2027-03-01")} – ${formatDateShort("2027-08-31")}`;
const base = { from: "2027-03-01", to: "2027-08-31", lostSavingMinor: 840000, delayMonths: 3, reachBefore: "2027-12", reachAfter: "2028-03" };

describe("planerad ledighet på sparmålets sida (KK-23-C)", () => {
  it("visar när målet nås med ledigheten och hur mycket mindre som sparas, bara för det här målet", async () => {
    api([200, { items: [PERIOD] }]);
    await open();
    expect(screen.getAllByRole("note").map((n) => n.textContent)).toEqual([`${leave} nås målet mars 2028, 3 mån senare. Det blir ${formatSek(840000)} mindre sparat.`]);
  });

  it("utan planerad ledighet, eller när den inte går att hämta, visas målet som vanligt", async () => {
    for (const answer of [[200, { items: [] }], [503, { error: "unavailable" }]] as [number, unknown][]) {
      api(answer);
      await open();
      expect(screen.getByRole("heading", { level: 1, name: "Resa till Japan" })).toBeTruthy();
      expect(screen.queryByRole("note")).toBeNull();
      cleanup();
    }
  });

  it("texten för varje fall", () => {
    expect(effectText({ ...base, delayMonths: 0, lostSavingMinor: 0 })).toBe(`${leave} nås målet ändå mars 2028.`);
    expect(effectText({ ...base, delayMonths: null })).toBe(`${leave} nås målet ändå mars 2028. Det blir ${formatSek(840000)} mindre sparat.`);
    expect(effectText({ ...base, reachAfter: null })).toBe(`${leave} nås målet inte i den takten. Det blir ${formatSek(840000)} mindre sparat.`);
    expect(effectText({ ...base, reachBefore: null, reachAfter: null })).toBe(`${leave} påverkas inte målet.`);
  });
});
