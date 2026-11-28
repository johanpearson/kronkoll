// @vitest-environment jsdom
// Synkstatus i sidhuvudet (KK-64-A): en ikon som snurrar under synken, visar en bock en kort stund när den är
// klar och en varning om den misslyckades. Ett tryck visar senaste synk, eventuellt fel och Synka nu i ett ark.
// Synken visar ingen notis.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../toast.tsx";
import { DONE_MS, MAX_WAIT_MS, POLL_MS, SyncStatus } from "./SyncStatus.tsx";

const STARTED = "2026-11-15T06:00:00.000Z";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function api(responses: { sync?: [number, unknown]; progress?: () => [number, unknown] } = {}) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://app.test");
      calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
      const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));
      if (init?.method === "POST") return json(...(responses.sync ?? [202, { status: "started", started_at: STARTED }]));
      return json(...(responses.progress?.() ?? [200, { done: true }]));
    }),
  );
  return calls;
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

function setup(onDone = vi.fn()) {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  render(
    <ToastProvider>
      <SyncStatus lastSyncAt="2026-11-15T05:02:11.000Z" onDone={onDone} />
    </ToastProvider>,
  );
  return onDone;
}

const icon = (name: string) => screen.getByRole("button", { name });

async function startFromSheet() {
  fireEvent.click(icon("Synkstatus"));
  fireEvent.click(screen.getByRole("button", { name: "Synka nu" }));
  await settle();
}

describe("synkstatus (KK-64-A)", () => {
  it("ett tryck på ikonen visar senaste synk och Synka nu i ett ark", () => {
    api();
    setup();
    fireEvent.click(icon("Synkstatus"));
    const sheet = screen.getByRole("dialog", { name: "Synk" });
    expect(sheet.textContent).toContain("Senast synkad 15 nov. 06:02");
    expect(screen.getByRole("button", { name: "Synka nu" })).toBeTruthy();
  });

  it("snurrar under synken, visar en bock när den är klar och sedan vanliga ikonen, utan notis", async () => {
    let polls = 0;
    const calls = api({ progress: () => [200, { done: ++polls > 1 }] });
    const onDone = setup();
    await startFromSheet();
    expect(calls).toContain("POST /api/sync");
    // Arket stängs när synken startar, och ikonen visar att den pågår.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(icon("Synkar…").querySelector("svg")?.getAttribute("class")).toContain("spin");
    expect(icon("Synkar…").getAttribute("aria-busy")).toBe("true");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    });
    await settle();
    expect(icon("Synken är klar")).toBeTruthy();
    expect(onDone).toHaveBeenCalledOnce();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("Synken är klar.").getAttribute("aria-live")).toBe("polite");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DONE_MS);
    });
    expect(icon("Synkstatus")).toBeTruthy();
  });

  it("visar en varning när synken tar för lång tid, hämtar om ändå och förklarar i arket", async () => {
    api({ progress: () => [200, { done: false }] });
    const onDone = setup();
    await startFromSheet();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MAX_WAIT_MS + POLL_MS);
    });
    await settle();
    expect(onDone).toHaveBeenCalledOnce();
    fireEvent.click(icon("Synken misslyckades"));
    expect(screen.getByRole("dialog").textContent).toContain("Synken tar längre tid än vanligt. Ladda om sidan om en stund för att se allt.");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([
    [[429, { error: "too_soon", retry_after_s: 400 }], "Du kan synka igen om 7 min."],
    [[429, { error: "too_soon" }], "Du kan synka igen om 1 min."],
    [[503, { error: "not_configured" }], "Det gick inte att starta synken. Försök igen om en stund."],
  ] as [[number, unknown], string][])("visar varför synken inte startade i arket", async (sync, message) => {
    api({ sync });
    const onDone = setup();
    await startFromSheet();
    fireEvent.click(icon("Synken misslyckades"));
    expect(screen.getByRole("dialog").textContent).toContain(message);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("säger Inte synkad än när ingen synk har gått", () => {
    api();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<SyncStatus lastSyncAt={null} onDone={() => undefined} />);
    fireEvent.click(icon("Synkstatus"));
    expect(screen.getByRole("dialog").textContent).toContain("Inte synkad än");
  });
});
