// @vitest-environment jsdom
// Dra för att synka (KK-63-D): högst upp på sidan ger en dragning nedåt en indikator som följer fingret, och
// släpps den förbi gränsen ber den synkstatusen att synka.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onSyncRequest } from "../sync/SyncStatus.tsx";
import { usePullToSync } from "./usePullToSync.ts";

function View(props: { enabled?: boolean }) {
  const { handlers, distance } = usePullToSync(props.enabled ?? true);
  return (
    <div data-testid="view" {...handlers}>
      <span data-testid="distance">{distance}</span>
    </div>
  );
}

let requested: ReturnType<typeof vi.fn>;
let stop: () => void;

beforeEach(() => {
  requested = vi.fn();
  stop = onSyncRequest(requested);
  Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
});

afterEach(() => {
  stop();
  cleanup();
});

const view = () => screen.getByTestId("view");
const distance = () => Number(screen.getByTestId("distance").textContent);
const pull = (from: [number, number], to: [number, number], release = true) => {
  fireEvent.pointerDown(view(), { pointerId: 1, pointerType: "touch", clientX: from[0], clientY: from[1] });
  fireEvent.pointerMove(view(), { pointerId: 1, pointerType: "touch", clientX: (from[0] + to[0]) / 2, clientY: (from[1] + to[1]) / 2 });
  fireEvent.pointerMove(view(), { pointerId: 1, pointerType: "touch", clientX: to[0], clientY: to[1] });
  if (release) fireEvent.pointerUp(view(), { pointerId: 1, pointerType: "touch", clientX: to[0], clientY: to[1] });
};

describe("usePullToSync (KK-63-D)", () => {
  it("indikatorn följer fingret, och en lång dragning ber om en synk", () => {
    render(<View />);
    pull([200, 100], [200, 400], false);
    expect(distance()).toBeGreaterThan(72);
    fireEvent.pointerUp(view(), { pointerId: 1, clientX: 200, clientY: 400 });
    expect(requested).toHaveBeenCalledOnce();
    expect(distance()).toBe(0);
  });

  it("en kort dragning släpps utan synk", () => {
    render(<View />);
    pull([200, 100], [200, 180]);
    expect(requested).not.toHaveBeenCalled();
    expect(distance()).toBe(0);
  });

  it("startar inte när sidan är scrollad, vid drag uppåt eller i sidled, med mus eller när den är avstängd", () => {
    render(<View />);
    Object.defineProperty(window, "scrollY", { value: 50, configurable: true });
    pull([200, 100], [200, 500]);
    Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
    pull([200, 500], [200, 100]);
    pull([100, 100], [400, 130]);
    fireEvent.pointerDown(view(), { pointerId: 1, pointerType: "mouse", clientX: 200, clientY: 100 });
    fireEvent.pointerMove(view(), { pointerId: 1, pointerType: "mouse", clientX: 200, clientY: 500 });
    fireEvent.pointerUp(view(), { pointerId: 1, pointerType: "mouse", clientX: 200, clientY: 500 });
    cleanup();
    render(<View enabled={false} />);
    pull([200, 100], [200, 500]);
    expect(requested).not.toHaveBeenCalled();
  });

  it("ett avbrutet drag släpps utan synk", () => {
    render(<View />);
    pull([200, 100], [200, 400], false);
    fireEvent.pointerCancel(view(), { pointerId: 1 });
    expect(distance()).toBe(0);
    expect(requested).not.toHaveBeenCalled();
  });
});
