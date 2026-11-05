// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Notifications } from "./Notifications.tsx";
import type { DeviceSubscription, PushDevice } from "./push-device.ts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

/** Påhittad prenumeration (KK-13). */
const SUB: DeviceSubscription = { endpoint: "https://web.push.apple.com/exempel", keys: { p256dh: "BKEY", auth: "AUTH" } };

function fakeDevice(options: { available?: boolean; current?: DeviceSubscription | null; permission?: "granted" | "denied" } = {}) {
  let current = options.current ?? null;
  const subscribe = vi.fn((publicKey: string) => {
    if (options.permission === "denied" || publicKey === "") return Promise.resolve("denied" as const);
    current = SUB;
    return Promise.resolve(SUB);
  });
  const unsubscribe = vi.fn(() => {
    const endpoint = current?.endpoint ?? null;
    current = null;
    return Promise.resolve(endpoint);
  });
  const device: PushDevice = {
    available: () => Promise.resolve(options.available ?? true),
    current: () => Promise.resolve(current),
    subscribe,
    unsubscribe,
  };
  return { device, subscribe, unsubscribe };
}

function api(config: [number, unknown] = [200, { configured: true, public_key: "BPUB", topics: [] }], post = 201) {
  const calls: { method: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://app.test").pathname;
      const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));
      if (path === "/api/push") return json(...config);
      if (path === "/api/push/subscriptions") {
        calls.push({ method: init?.method ?? "GET", body: JSON.parse(typeof init?.body === "string" ? init.body : "null") as unknown });
        return init?.method === "DELETE" ? Promise.resolve(new Response(null, { status: 204 })) : json(post, { id: "p1" });
      }
      return json(404, {});
    }),
  );
  return calls;
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

const box = (name: RegExp) => screen.getByRole<HTMLInputElement>("checkbox", { name });

describe("notisinställningar (KK-27)", () => {
  it("utan prenumeration är alla reglage av, och första valet prenumererar och sparar typen", async () => {
    const calls = api();
    const { device, subscribe } = fakeDevice();
    render(<Notifications device={device} />);
    await settle();
    expect(screen.getAllByRole("checkbox").map((c) => (c as HTMLInputElement).checked)).toEqual([false, false, false]);
    fireEvent.click(box(/Budget överskriden/u));
    await settle();
    expect(subscribe).toHaveBeenCalledWith("BPUB");
    expect(calls).toEqual([{ method: "POST", body: { ...SUB, topics: ["budget_over"] } }]);
    expect(box(/Budget överskriden/u).checked).toBe(true);
    expect(screen.getByRole("status").textContent).toBe("Sparat.");
    expect(window.localStorage.getItem("kronkoll.push-topics")).toBe('["budget_over"]');
  });

  it("en befintlig prenumeration visar de sparade valen, och att stänga av det sista tar bort den", async () => {
    window.localStorage.setItem("kronkoll.push-topics", '["consent"]');
    const calls = api();
    const { device, unsubscribe } = fakeDevice({ current: SUB });
    render(<Notifications device={device} />);
    await settle();
    expect(box(/Samtycket/u).checked).toBe(true);
    expect(box(/Synken/u).checked).toBe(false);
    fireEvent.click(box(/Samtycket/u));
    await settle();
    expect(unsubscribe).toHaveBeenCalled();
    expect(calls).toEqual([{ method: "DELETE", body: { endpoint: SUB.endpoint } }]);
    expect(box(/Samtycket/u).checked).toBe(false);
  });

  it("en prenumeration utan sparade val visar alla typer som påslagna", async () => {
    api();
    render(<Notifications device={fakeDevice({ current: SUB }).device} />);
    await settle();
    expect(screen.getAllByRole("checkbox").map((c) => (c as HTMLInputElement).checked)).toEqual([true, true, true]);
  });

  it("nekat lov visar hur man tillåter notiser och lämnar reglaget av", async () => {
    const calls = api();
    render(<Notifications device={fakeDevice({ permission: "denied" }).device} />);
    await settle();
    fireEvent.click(box(/Synken/u));
    await settle();
    expect(screen.getByRole("alert").textContent).toMatch(/blockerade/u);
    expect(box(/Synken/u).checked).toBe(false);
    expect(calls).toEqual([]);
  });

  it("ett fel från servern visas och valet ändras inte", async () => {
    api(undefined, 503);
    render(<Notifications device={fakeDevice().device} />);
    await settle();
    fireEvent.click(box(/Budget/u));
    await settle();
    expect(screen.getByRole("alert").textContent).toBe("Det gick inte att spara. Försök igen.");
    expect(box(/Budget/u).checked).toBe(false);
  });

  it.each([
    ["servern saknar nycklar", [200, { configured: false, public_key: null, topics: [] }], true, "Notiser är inte påslagna på servern än."],
    ["servern svarar inte", [503, { error: "unavailable" }], true, "Det gick inte att hämta inställningen för notiser."],
    ["webbläsaren saknar stöd", [200, { configured: true, public_key: "BPUB", topics: [] }], false, /installerad på hemskärmen/u],
  ] as const)("%s: inga reglage, bara en förklaring", async (_, config, available, text) => {
    api(config as [number, unknown]);
    render(<Notifications device={fakeDevice({ available }).device} />);
    await settle();
    expect(screen.queryAllByRole("checkbox")).toEqual([]);
    expect(screen.getByText(text)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
