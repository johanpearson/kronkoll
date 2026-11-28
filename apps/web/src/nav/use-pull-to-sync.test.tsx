// @vitest-environment jsdom
// Dra för att synka (KK-63-D): högst upp på sidan ger en dragning nedåt en indikator som följer fingret, och
// släpps den förbi gränsen ber den synkstatusen att synka. Hooken lyssnar på touch-händelser med en egen,
// icke-passiv lyssnare, så att den kan hindra webbläsarens egen scrollning medan den drar (#247).
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onSyncRequest } from "../sync/SyncStatus.tsx";
import { usePullToSync } from "./usePullToSync.ts";

function View(props: { enabled?: boolean }) {
  const { ref, distance } = usePullToSync(props.enabled ?? true);
  return (
    <div data-testid="view" ref={ref}>
      <span data-testid="distance">{distance}</span>
    </div>
  );
}

let requested: ReturnType<typeof vi.fn<() => void>>;
let stop: () => void;

beforeEach(() => {
  requested = vi.fn<() => void>();
  stop = onSyncRequest(requested);
  Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
});

afterEach(() => {
  stop();
  cleanup();
  document.querySelectorAll("dialog").forEach((d) => { d.remove(); });
});

const view = () => screen.getByTestId("view");
const distance = () => Number(screen.getByTestId("distance").textContent);
const at = (x: number, y: number) => ({ touches: [{ clientX: x, clientY: y }] });
/** Flyttar fingret och säger om webbläsarens egen scrollning stoppades. */
const move = (x: number, y: number) => !fireEvent.touchMove(view(), { ...at(x, y), cancelable: true });
const pull = (from: [number, number], to: [number, number], release = true) => {
  fireEvent.touchStart(view(), at(...from));
  move((from[0] + to[0]) / 2, (from[1] + to[1]) / 2);
  move(...to);
  if (release) fireEvent.touchEnd(view(), { touches: [] });
};

describe("usePullToSync (KK-63-D)", () => {
  it("indikatorn följer fingret, scrollningen stoppas, och en lång dragning ber om en synk", () => {
    render(<View />);
    fireEvent.touchStart(view(), at(200, 100));
    expect(move(200, 130)).toBe(true);
    expect(move(200, 400)).toBe(true);
    expect(distance()).toBeGreaterThan(72);
    fireEvent.touchEnd(view(), { touches: [] });
    expect(requested).toHaveBeenCalledOnce();
    expect(distance()).toBe(0);
  });

  it("en kort dragning släpps utan synk", () => {
    render(<View />);
    pull([200, 100], [200, 180]);
    expect(requested).not.toHaveBeenCalled();
    expect(distance()).toBe(0);
  });

  it("låter webbläsaren scrolla som vanligt vid drag uppåt eller i sidled", () => {
    render(<View />);
    fireEvent.touchStart(view(), at(200, 500));
    expect(move(200, 400)).toBe(false);
    fireEvent.touchEnd(view(), { touches: [] });
    fireEvent.touchStart(view(), at(100, 100));
    expect(move(300, 110)).toBe(false);
    expect(move(400, 300)).toBe(false);
    fireEvent.touchEnd(view(), { touches: [] });
    expect(requested).not.toHaveBeenCalled();
  });

  it("startar inte när sidan är scrollad, när ett ark är öppet, med två fingrar eller när den är avstängd", () => {
    render(<View />);
    Object.defineProperty(window, "scrollY", { value: 50, configurable: true });
    pull([200, 100], [200, 500]);
    Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.append(dialog);
    pull([200, 100], [200, 500]);
    dialog.remove();
    fireEvent.touchStart(view(), { touches: [{ clientX: 200, clientY: 100 }, { clientX: 250, clientY: 100 }] });
    move(200, 500);
    fireEvent.touchEnd(view(), { touches: [] });
    cleanup();
    render(<View enabled={false} />);
    pull([200, 100], [200, 500]);
    expect(requested).not.toHaveBeenCalled();
  });

  it("ett avbrutet drag släpps utan synk", () => {
    render(<View />);
    pull([200, 100], [200, 400], false);
    fireEvent.touchCancel(view(), { touches: [] });
    expect(distance()).toBe(0);
    expect(requested).not.toHaveBeenCalled();
  });
});
