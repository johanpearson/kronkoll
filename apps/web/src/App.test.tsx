// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App.tsx";
import { startHistory } from "./router.tsx";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

function at(path: string) {
  window.history.replaceState(null, "", path);
  startHistory();
  return render(<App />);
}

describe("appskalet (#30, KK-4)", () => {
  it("visar översikten som startsida, på svenska", () => {
    at("/");
    expect(screen.getByRole("heading", { level: 1, name: "Översikt" })).toBeDefined();
    expect(document.documentElement.lang === "" || document.documentElement.lang === "sv").toBe(true);
  });

  it("visar en sida som inte finns, med väg tillbaka till start", async () => {
    at("/finns-inte");
    expect(screen.getByRole("heading", { name: "Sidan finns inte" })).toBeDefined();
    fireEvent.click(screen.getByRole("link", { name: "Till start" }));
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Sidan finns inte" })).toBeNull();
    });
    expect(window.location.pathname).toBe("/");
  });

  it("följer webbläsarens bakåt och framåt", () => {
    at("/");
    act(() => {
      // Det webbläsaren gör vid bakåt: adressen byts och popstate skickas.
      window.history.replaceState(null, "", "/finns-inte");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.getByRole("heading", { name: "Sidan finns inte" })).toBeDefined();
  });

  it("visar designsidan /_design i utvecklingsläget (KK-65-E)", async () => {
    expect(import.meta.env.DEV).toBe(true);
    at("/_design");
    expect(await screen.findByRole("heading", { level: 1, name: "Designsystem" })).toBeDefined();
  });

  it("undervyer har en tillbakaknapp, flikar har det inte (KK-62-B)", async () => {
    at("/installningar/regler");
    fireEvent.click(screen.getByRole("button", { name: "Tillbaka" }));
    await waitFor(() => {
      expect(window.location.pathname).toBe("/installningar");
    });
    cleanup();
    at("/budget");
    expect(screen.queryByRole("button", { name: "Tillbaka" })).toBeNull();
  });

  it("vyn får en klass för hur den kommer in (KK-62-H)", async () => {
    const { container } = at("/budget");
    expect(container.querySelector(".ui-view")?.classList.contains("ui-view-initial")).toBe(true);
    fireEvent.click(screen.getByRole("link", { name: "Lån" }));
    await waitFor(() => {
      expect(container.querySelector(".ui-view")?.classList.contains("ui-view-tab")).toBe(true);
    });
  });

  describe("svep mellan flikar (KK-63)", () => {
    const view = (container: HTMLElement) => container.querySelector(".ui-view") as HTMLElement;
    const swipe = (element: HTMLElement, from: [number, number], to: [number, number], target: Element = element) => {
      fireEvent.pointerDown(target, { pointerId: 1, clientX: from[0], clientY: from[1] });
      fireEvent.pointerMove(target, { pointerId: 1, clientX: (from[0] + to[0]) / 2, clientY: (from[1] + to[1]) / 2 });
      fireEvent.pointerMove(target, { pointerId: 1, clientX: to[0], clientY: to[1] });
      fireEvent.pointerUp(target, { pointerId: 1, clientX: to[0], clientY: to[1] });
    };

    it("ett svep åt vänster går till nästa flik och åt höger till föregående, utan nytt steg (KK-63-A, C)", async () => {
      const { container } = at("/budget");
      const before = window.history.length;
      swipe(view(container), [700, 300], [200, 310]);
      await waitFor(() => {
        expect(window.location.pathname).toBe("/lan");
      });
      expect(window.history.length).toBe(before);
      swipe(view(container), [300, 300], [800, 300]);
      await waitFor(() => {
        expect(window.location.pathname).toBe("/budget");
      });
    });

    it("vyn följer fingret och studsar tillbaka efter ett kort svep", async () => {
      const { container } = at("/budget");
      const element = view(container);
      fireEvent.pointerDown(element, { pointerId: 1, clientX: 600, clientY: 300 });
      fireEvent.pointerMove(element, { pointerId: 1, clientX: 560, clientY: 300 });
      expect(element.style.transform).toBe("translateX(-40px)");
      await new Promise((r) => setTimeout(r, 120));
      fireEvent.pointerUp(element, { pointerId: 1, clientX: 560, clientY: 300 });
      expect(element.style.transform).toBe("");
      expect(window.location.pathname).toBe("/budget");
    });

    it("ett lodrätt drag är scrollning och byter inte flik", () => {
      const { container } = at("/budget");
      swipe(view(container), [600, 100], [400, 700]);
      expect(window.location.pathname).toBe("/budget");
    });

    it("svep startar inte i undervyer, från kanten, i formulär eller förbi menyns ände (KK-63-B)", () => {
      let { container } = at("/installningar/regler");
      swipe(view(container), [700, 300], [100, 300]);
      expect(window.location.pathname).toBe("/installningar/regler");
      cleanup();
      ({ container } = at("/budget"));
      swipe(view(container), [10, 300], [700, 300]);
      expect(window.location.pathname).toBe("/budget");
      const input = document.createElement("input");
      view(container).append(input);
      swipe(view(container), [700, 300], [100, 300], input);
      expect(window.location.pathname).toBe("/budget");
      cleanup();
      ({ container } = at("/inkomst"));
      swipe(view(container), [700, 300], [100, 300]);
      expect(window.location.pathname).toBe("/inkomst");
    });
  });

  it("en länk med modifierare öppnas som vanligt av webbläsaren", () => {
    at("/finns-inte");
    const link = screen.getByRole("link", { name: "Till start" });
    const notPrevented = fireEvent.click(link, { ctrlKey: true });
    expect(notPrevented).toBe(true);
    expect(window.location.pathname).toBe("/finns-inte");
  });
});
