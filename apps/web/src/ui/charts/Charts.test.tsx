// @vitest-environment jsdom
// Diagram (KK-65-B): staplar, ring och linje i SVG. Läsbara för skärmläsare som en lista med värden,
// och de fylls från noll första gången de syns, utom vid minskad rörelse.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BarChart, LineChart, RingChart } from "./Charts.tsx";
import { CountUp } from "./CountUp.tsx";

let observed: { callback: IntersectionObserverCallback; disconnect: ReturnType<typeof vi.fn> }[] = [];
const animate = vi.fn(() => ({}) as Animation);

beforeEach(() => {
  observed = [];
  window.matchMedia = vi.fn(() => ({ matches: false }) as MediaQueryList);
  window.IntersectionObserver = vi.fn(function (callback: IntersectionObserverCallback) {
    const entry = { callback, disconnect: vi.fn() };
    observed.push(entry);
    return { observe: vi.fn(), disconnect: entry.disconnect };
  }) as unknown as typeof IntersectionObserver;
  Element.prototype.animate = animate;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  // @ts-expect-error jsdom saknar dem, och testerna lägger till dem själva.
  delete window.matchMedia;
  // @ts-expect-error jsdom saknar IntersectionObserver
  delete window.IntersectionObserver;
  // @ts-expect-error jsdom saknar Web Animations
  delete Element.prototype.animate;
});

/** formatSek använder hårda mellanslag. */
const text = (element: Element | null | undefined) => element?.textContent.replace(/\s/gu, " ");

/** Det som händer när diagrammet scrollas in i bild. */
function scrollIntoView(visible = true) {
  act(() => {
    for (const o of observed) o.callback([{ isIntersecting: visible } as IntersectionObserverEntry], {} as IntersectionObserver);
  });
}

const BARS = [
  { label: "sep.", valueMinor: 400_000 },
  { label: "okt.", valueMinor: 200_000 },
];

describe("BarChart", () => {
  it("är en bild med namn och en dold lista med värdena", () => {
    render(<BarChart label="Utgifter per månad" bars={BARS} />);
    const chart = screen.getByRole("img", { name: "Utgifter per månad" });
    expect(chart.querySelectorAll("rect")).toHaveLength(2);
    expect(text(screen.getByRole("list", { name: "Utgifter per månad" }))).toContain("okt.: 2 000,00 kr");
  });

  it("växer från noll en gång, när den först syns", () => {
    render(<BarChart label="Utgifter" bars={BARS} />);
    expect(animate).not.toHaveBeenCalled();
    scrollIntoView(false);
    expect(animate).not.toHaveBeenCalled();
    scrollIntoView();
    expect(animate).toHaveBeenCalledTimes(2);
    expect(animate).toHaveBeenCalledWith([{ transform: "scaleY(0)" }, { transform: "scaleY(1)" }], expect.objectContaining({ duration: 500 }));
    expect(observed[0]?.disconnect).toHaveBeenCalled();
  });

  it("står stilla vid minskad rörelse", () => {
    window.matchMedia = vi.fn(() => ({ matches: true }) as MediaQueryList);
    render(<BarChart label="Utgifter" bars={BARS} />);
    scrollIntoView();
    expect(observed).toHaveLength(0);
    expect(animate).not.toHaveBeenCalled();
  });

  it("växer direkt i en webbläsare utan IntersectionObserver", () => {
    // @ts-expect-error äldre webbläsare
    delete window.IntersectionObserver;
    render(<BarChart label="Utgifter" bars={BARS} />);
    expect(animate).toHaveBeenCalledTimes(2);
  });
});

describe("RingChart", () => {
  it("visar hur stor del av målet som är nådd, med texten i mitten", () => {
    render(<RingChart label="Mat" valueMinor={300_000} totalMinor={400_000} center="75 %" />);
    const ring = screen.getByRole("img", { name: /^Mat: 3\s000,00\skr av 4\s000,00\skr$/u });
    expect(ring.querySelector(".ui-ring-value")?.getAttribute("class")).toBe("ui-ring-value");
    expect(screen.getByText("75 %")).toBeDefined();
    scrollIntoView();
    expect(animate).toHaveBeenCalledOnce();
  });

  it("blir röd när målet är passerat", () => {
    render(<RingChart label="Mat" valueMinor={500_000} totalMinor={400_000} />);
    expect(screen.getByRole("img").querySelector(".ui-ring-value")?.getAttribute("class")).toBe("ui-ring-value ui-ring-over");
  });
});

describe("LineChart", () => {
  it("ritar en linje genom punkterna och listar dem för skärmläsare", () => {
    render(<LineChart label="Saldo" points={BARS} />);
    const chart = screen.getByRole("img", { name: "Saldo" });
    expect(chart.querySelector("polyline")?.getAttribute("points")).toBeTruthy();
    expect(screen.getByRole("list", { name: "Saldo" }).children).toHaveLength(2);
    scrollIntoView();
    expect(animate).toHaveBeenCalledOnce();
  });
});

describe("CountUp (KK-65-B)", () => {
  it("räknar upp till beloppet men läser upp slutvärdet direkt", () => {
    vi.useFakeTimers();
    const { container } = render(<CountUp valueMinor={1_000_000} />);
    expect(screen.getByText("10 000,00 kr").className).toBe("ui-visually-hidden");
    const shown = container.querySelector("[aria-hidden]");
    expect(text(shown)).toBe("0,00 kr");
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(text(shown)).toBe("10 000,00 kr");
  });

  it("visar beloppet direkt vid minskad rörelse", () => {
    window.matchMedia = vi.fn(() => ({ matches: true }) as MediaQueryList);
    const { container } = render(<CountUp valueMinor={250_00} />);
    expect(text(container.querySelector("[aria-hidden]"))).toBe("250,00 kr");
  });
});
