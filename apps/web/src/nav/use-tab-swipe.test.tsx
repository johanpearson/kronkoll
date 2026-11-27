// @vitest-environment jsdom
// Kanterna i svepet mellan flikar (KK-63-B, F): det som själv scrollar i sidled, mus, ett öppet ark,
// avbrutna svep och minskad rörelse.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startHistory } from "../router.tsx";
import { useTabSwipe } from "./useTabSwipe.ts";

function View() {
  const swipe = useTabSwipe(true);
  return (
    <div data-testid="view" {...swipe}>
      <div data-testid="scroller" style={{ overflowX: "auto" }}>
        <span data-testid="inside">bred</span>
      </div>
    </div>
  );
}

beforeEach(() => {
  window.history.replaceState(null, "", "/budget");
  startHistory();
});

afterEach(() => {
  cleanup();
  document.querySelectorAll("dialog").forEach((d) => { d.remove(); });
  // @ts-expect-error jsdom saknar matchMedia
  delete window.matchMedia;
});

const drag = (target: Element, pointerType = "touch") => {
  const view = screen.getByTestId("view");
  fireEvent.pointerDown(target, { pointerId: 1, pointerType, clientX: 700, clientY: 300 });
  fireEvent.pointerMove(view, { pointerId: 1, pointerType, clientX: 500, clientY: 300 });
  fireEvent.pointerMove(view, { pointerId: 1, pointerType, clientX: 100, clientY: 300 });
  fireEvent.pointerUp(view, { pointerId: 1, pointerType, clientX: 100, clientY: 300 });
};

describe("useTabSwipe", () => {
  it("startar inte på något som själv scrollar i sidled", () => {
    render(<View />);
    const scroller = screen.getByTestId("scroller");
    Object.defineProperty(scroller, "scrollWidth", { value: 900 });
    Object.defineProperty(scroller, "clientWidth", { value: 300 });
    drag(screen.getByTestId("inside"));
    expect(window.location.pathname).toBe("/budget");
  });

  it("struntar i musen och i svep när ett ark är öppet", () => {
    render(<View />);
    drag(screen.getByTestId("view"), "mouse");
    expect(window.location.pathname).toBe("/budget");
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.append(dialog);
    drag(screen.getByTestId("view"));
    expect(window.location.pathname).toBe("/budget");
  });

  it("ett avbrutet svep studsar tillbaka", () => {
    render(<View />);
    const view = screen.getByTestId("view");
    fireEvent.pointerDown(view, { pointerId: 1, clientX: 700, clientY: 300 });
    fireEvent.pointerMove(view, { pointerId: 1, clientX: 600, clientY: 300 });
    expect(view.style.transform).toBe("translateX(-100px)");
    fireEvent.pointerCancel(view, { pointerId: 1 });
    expect(view.style.transform).toBe("");
    // Ett nytt pointerup efter avbrottet gör ingenting.
    fireEvent.pointerUp(view, { pointerId: 1, clientX: 100, clientY: 300 });
    expect(window.location.pathname).toBe("/budget");
  });

  it("vid minskad rörelse följer vyn inte fingret, men svepet byter ändå flik (KK-63-F)", async () => {
    window.matchMedia = vi.fn(() => ({ matches: true }) as MediaQueryList);
    render(<View />);
    const view = screen.getByTestId("view");
    fireEvent.pointerDown(view, { pointerId: 1, clientX: 700, clientY: 300 });
    fireEvent.pointerMove(view, { pointerId: 1, clientX: 400, clientY: 300 });
    expect(view.style.transform).toBe("");
    fireEvent.pointerUp(view, { pointerId: 1, clientX: 100, clientY: 300 });
    await vi.waitFor(() => {
      expect(window.location.pathname).toBe("/lan");
    });
  });
});
