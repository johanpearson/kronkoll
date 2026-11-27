// @vitest-environment jsdom
// Routern med historik som i en app (KK-62): flikbyten lägger inte till steg, undervyer gör det, och
// bakåt från Översikt lämnar appen. Webbläsarens riktiga historik i jsdom används, inte en attrapp.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Link, navigate, pushOverlay, replaceUrl, startHistory, usePath } from "./router.tsx";

const stack = () => (window.history.state as { stack: string[] } | null)?.stack;

/** Väntar tills routern är klar, eftersom bakåt i webbläsaren är asynkront. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 5));
  });
}

/** Det webbläsaren gör när användaren trycker bakåt. */
async function pressBack() {
  window.history.back();
  await settle();
}

function Path() {
  return <p data-testid="path">{usePath()}</p>;
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  cleanup();
});

describe("startHistory: stegen bakåt när appen öppnas (KK-62-G)", () => {
  it("bygger stegen bakåt för en djuplänk", async () => {
    window.history.replaceState(null, "", "/installningar/regler");
    const before = window.history.length;
    startHistory();
    expect(window.location.pathname).toBe("/installningar/regler");
    expect(stack()).toEqual(["/", "/installningar", "/installningar/regler"]);
    expect(window.history.length).toBe(before + 2);
    await pressBack();
    expect(window.location.pathname).toBe("/installningar");
    await pressBack();
    expect(window.location.pathname).toBe("/");
    expect(stack()).toEqual(["/"]);
  });

  it("behåller frågan i adressen", () => {
    window.history.replaceState(null, "", "/transaktioner?period=2026-11");
    startHistory();
    expect(stack()).toEqual(["/", "/transaktioner?period=2026-11"]);
    expect(window.location.search).toBe("?period=2026-11");
  });

  it("rör inte historiken när sidan laddas om", () => {
    window.history.replaceState({ stack: ["/", "/budget"] }, "", "/budget");
    const before = window.history.length;
    startHistory();
    expect(window.history.length).toBe(before);
    expect(stack()).toEqual(["/", "/budget"]);
  });
});

describe("navigate (KK-62-A, B, C)", () => {
  it("en undervy läggs ovanpå, och bakåt går till vyn den öppnades från", async () => {
    window.history.replaceState({ stack: ["/", "/transaktioner"] }, "", "/transaktioner");
    navigate("/transaktioner/t-1");
    await settle();
    expect(stack()).toEqual(["/", "/transaktioner", "/transaktioner/t-1"]);
    await pressBack();
    expect(window.location.pathname).toBe("/transaktioner");
  });

  it("ett flikbyte ersätter fliken, så att bakåt går till Översikt", async () => {
    startHistory();
    navigate("/budget", "tab");
    await settle();
    const before = window.history.length;
    navigate("/lan", "tab");
    await settle();
    expect(window.location.pathname).toBe("/lan");
    expect(stack()).toEqual(["/", "/lan"]);
    expect(window.history.length).toBe(before);
    await pressBack();
    expect(window.location.pathname).toBe("/");
  });

  it("Översikt från en undervy går tillbaka till första steget", async () => {
    startHistory();
    navigate("/transaktioner", "tab");
    await settle();
    navigate("/transaktioner/t-1");
    await settle();
    navigate("/", "tab");
    await settle();
    expect(window.location.pathname).toBe("/");
    expect(stack()).toEqual(["/"]);
  });

  it("en länk till en vy som redan ligger bakom går tillbaka dit i stället för att lägga till", async () => {
    window.history.replaceState({ stack: ["/", "/installningar"] }, "", "/installningar");
    navigate("/installningar/regler");
    await settle();
    navigate("/installningar");
    await settle();
    expect(stack()).toEqual(["/", "/installningar"]);
  });

  it("ritar inte mellanstegen medan den går bakåt", async () => {
    window.history.replaceState({ stack: ["/", "/budget"] }, "", "/budget");
    const seen: string[] = [];
    function Spy() {
      const path = usePath();
      seen.push(path);
      return null;
    }
    render(<Spy />);
    await act(async () => {
      navigate("/lan", "tab");
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(seen).not.toContain("/");
    expect(seen.at(-1)).toBe("/lan");
  });

  it("utan sparade steg utgår den från adressens steg", async () => {
    window.history.replaceState(null, "", "/budget");
    navigate("/transaktioner/t-1");
    await settle();
    expect(stack()).toEqual(["/", "/budget", "/transaktioner/t-1"]);
  });
});

describe("replaceUrl", () => {
  it("byter adress utan att tappa stegen bakåt", () => {
    window.history.replaceState({ stack: ["/", "/transaktioner?kategori=mat"] }, "", "/transaktioner?kategori=mat");
    replaceUrl("/transaktioner");
    expect(window.location.search).toBe("");
    expect(stack()).toEqual(["/", "/transaktioner"]);
  });
});

describe("Link", () => {
  it("byter flik utan nytt steg när den är en flik i menyn", async () => {
    window.history.replaceState({ stack: ["/", "/budget"] }, "", "/budget");
    render(
      <>
        <Link to="/lan" tab>
          Lån
        </Link>
        <Path />
      </>,
    );
    fireEvent.click(screen.getByRole("link", { name: "Lån" }));
    await settle();
    expect(screen.getByTestId("path").textContent).toBe("/lan");
    expect(stack()).toEqual(["/", "/lan"]);
  });
});

describe("pushOverlay: bakåt stänger ett ark eller en dialog (KK-62-E)", () => {
  const overlay = () => (window.history.state as { overlay?: boolean } | null)?.overlay === true;

  it("lägger till ett steg på samma adress, och bakåt stänger i stället för att byta vy", async () => {
    startHistory();
    navigate("/budget", "tab");
    await settle();
    const before = window.history.length;
    let closed = 0;
    pushOverlay(() => {
      closed += 1;
    });
    expect(window.history.length).toBe(before + 1);
    expect(overlay()).toBe(true);
    expect(window.location.pathname).toBe("/budget");
    expect(stack()).toEqual(["/", "/budget"]);
    await pressBack();
    expect(closed).toBe(1);
    expect(window.location.pathname).toBe("/budget");
    expect(overlay()).toBe(false);
  });

  it("när arket stängs på annat sätt tas steget bort igen", async () => {
    startHistory();
    navigate("/budget", "tab");
    await settle();
    let closed = 0;
    const release = pushOverlay(() => {
      closed += 1;
    });
    release();
    await settle();
    expect(overlay()).toBe(false);
    expect(window.location.pathname).toBe("/budget");
    expect(closed).toBe(0);
    // Nästa bakåt går till Översikt, inte till arket.
    await pressBack();
    expect(window.location.pathname).toBe("/");
  });

  it("öppnas det igen direkt (React StrictMode) återanvänds steget", async () => {
    startHistory();
    const release = pushOverlay(() => undefined);
    release();
    let closed = 0;
    pushOverlay(() => {
      closed += 1;
    });
    await settle();
    expect(overlay()).toBe(true);
    // Bara ett steg: ett tryck bakåt räcker för att stänga.
    await pressBack();
    expect(overlay()).toBe(false);
    expect(closed).toBe(1);
  });

  it("att byta vy från ett öppet ark tar bort arkets steg", async () => {
    startHistory();
    navigate("/installningar");
    await settle();
    pushOverlay(() => undefined);
    navigate("/installningar/regler");
    await settle();
    expect(stack()).toEqual(["/", "/installningar", "/installningar/regler"]);
    await pressBack();
    expect(window.location.pathname).toBe("/installningar");
    expect(overlay()).toBe(false);
  });
});

describe("flikarna kommer ihåg var man var (KK-62-F)", () => {
  let scrolls: [number, number][] = [];
  beforeEach(() => {
    scrolls = [];
    window.scrollTo = vi.fn((x: number, y: number) => {
      scrolls.push([x, y]);
      Object.defineProperty(window, "scrollY", { value: y, configurable: true });
    }) as unknown as typeof window.scrollTo;
    Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
  });

  it("en flik öppnas på sin senaste undervy och scrollposition", async () => {
    startHistory();
    navigate("/transaktioner", "tab");
    await settle();
    navigate("/transaktioner/t-1");
    await settle();
    Object.defineProperty(window, "scrollY", { value: 480, configurable: true });
    navigate("/budget", "tab");
    await settle();
    expect(scrolls.at(-1)).toEqual([0, 0]);
    navigate("/transaktioner", "tab");
    await settle();
    expect(window.location.pathname).toBe("/transaktioner/t-1");
    expect(stack()).toEqual(["/", "/transaktioner", "/transaktioner/t-1"]);
    expect(scrolls.at(-1)).toEqual([0, 480]);
  });

  it("ett tryck på fliken man står på går till startsidan och överst", async () => {
    startHistory();
    navigate("/transaktioner", "tab");
    await settle();
    navigate("/transaktioner/t-1");
    await settle();
    Object.defineProperty(window, "scrollY", { value: 300, configurable: true });
    navigate("/transaktioner", "tab");
    await settle();
    expect(window.location.pathname).toBe("/transaktioner");
    expect(scrolls.at(-1)).toEqual([0, 0]);
  });

  it("försöker igen tills innehållet har laddats och sidan är lång nog", async () => {
    startHistory();
    navigate("/budget", "tab");
    await settle();
    Object.defineProperty(window, "scrollY", { value: 600, configurable: true });
    navigate("/lan", "tab");
    await settle();
    // Första försöken kommer inte ner, eftersom sidan ännu är kort.
    let calls = 0;
    window.scrollTo = vi.fn((_x: number, y: number) => {
      calls += 1;
      Object.defineProperty(window, "scrollY", { value: calls < 3 ? 0 : y, configurable: true });
    }) as unknown as typeof window.scrollTo;
    navigate("/budget", "tab");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    expect(calls).toBe(3);
    expect(window.scrollY).toBe(600);
  });

  it("en ny undervy börjar överst", async () => {
    startHistory();
    Object.defineProperty(window, "scrollY", { value: 200, configurable: true });
    navigate("/installningar");
    await settle();
    expect(scrolls.at(-1)).toEqual([0, 0]);
  });
});
