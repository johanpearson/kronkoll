// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../toast.tsx";
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

const box = (name: RegExp) => screen.getByRole<HTMLInputElement>("switch", { name });
const states = () => screen.getAllByRole<HTMLInputElement>("switch").map((c) => c.checked);
const saveButton = () => screen.getByRole<HTMLButtonElement>("button", { name: "Spara" });

async function show(device: PushDevice) {
  render(
    <ToastProvider>
      <Notifications device={device} />
    </ToastProvider>,
  );
  await settle();
}

describe("notisinställningar (KK-27)", () => {
  it("reglagen ändrar inget förrän Spara, som prenumererar och skickar de valda typerna", async () => {
    const calls = api();
    const { device, subscribe } = fakeDevice();
    await show(device);
    expect(screen.getByText("Notiser är av för den här enheten.")).toBeTruthy();
    expect(states()).toEqual([false, false, false]);
    expect(saveButton().disabled).toBe(true);
    fireEvent.click(box(/budget är överskriden/u));
    fireEvent.click(box(/Synken/u));
    expect(states()).toEqual([false, true, true]);
    expect(subscribe).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());
    await settle();
    expect(subscribe).toHaveBeenCalledWith("BPUB");
    expect(calls).toEqual([{ method: "POST", body: { ...SUB, topics: ["budget_over", "sync_failed"] } }]);
    expect(screen.getByRole("status").textContent).toBe("Notiserna är sparade.");
    expect(screen.getByText("Notiser är på för den här enheten.")).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
    expect(window.localStorage.getItem("kronkoll.push-topics")).toBe('["budget_over","sync_failed"]');
  });

  it("Ångra återställer reglagen, och att slå av och på samma reglage ger inget att spara", async () => {
    api();
    await show(fakeDevice().device);
    fireEvent.click(box(/Samtycket/u));
    fireEvent.click(screen.getByRole("button", { name: "Ångra" }));
    expect(states()).toEqual([false, false, false]);
    fireEvent.click(box(/Samtycket/u));
    fireEvent.click(box(/Samtycket/u));
    expect(saveButton().disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Ångra" })).toBeNull();
  });

  it("en befintlig prenumeration visar de sparade valen, och att spara utan val tar bort den", async () => {
    window.localStorage.setItem("kronkoll.push-topics", '["consent"]');
    const calls = api();
    const { device, unsubscribe } = fakeDevice({ current: SUB });
    await show(device);
    expect(states()).toEqual([true, false, false]);
    fireEvent.click(box(/Samtycket/u));
    fireEvent.click(saveButton());
    await settle();
    expect(unsubscribe).toHaveBeenCalled();
    expect(calls).toEqual([{ method: "DELETE", body: { endpoint: SUB.endpoint } }]);
    expect(screen.getByRole("status").textContent).toBe("Notiserna är avstängda på den här enheten.");
    expect(screen.getByText("Notiser är av för den här enheten.")).toBeTruthy();
  });

  it("en prenumeration utan sparade val visar alla typer som påslagna", async () => {
    api();
    await show(fakeDevice({ current: SUB }).device);
    expect(states()).toEqual([true, true, true]);
  });

  it("medan det sparas står det Sparar… och reglagen går inte att ändra", async () => {
    api();
    const { device } = fakeDevice();
    let release: () => void = () => undefined;
    device.subscribe = () => new Promise((resolve) => { release = () => { resolve(SUB); }; });
    await show(device);
    fireEvent.click(box(/Synken/u));
    fireEvent.click(saveButton());
    await settle();
    const busy = screen.getByRole<HTMLButtonElement>("button", { name: "Sparar…" });
    expect(busy.disabled).toBe(true);
    expect(box(/Synken/u).disabled).toBe(true);
    release();
    await settle();
    expect(saveButton().disabled).toBe(true);
  });

  it("nekat lov visar hur man tillåter notiser, och reglagen ligger kvar så att man kan försöka igen", async () => {
    const calls = api();
    await show(fakeDevice({ permission: "denied" }).device);
    fireEvent.click(box(/Synken/u));
    fireEvent.click(saveButton());
    await settle();
    expect(screen.getByRole("alert").textContent).toMatch(/blockerade/u);
    expect(box(/Synken/u).checked).toBe(true);
    expect(saveButton().disabled).toBe(false);
    expect(calls).toEqual([]);
    fireEvent.click(box(/Samtycket/u));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("ett fel från servern visas och sparade val ändras inte", async () => {
    api(undefined, 503);
    await show(fakeDevice().device);
    fireEvent.click(box(/budget/u));
    fireEvent.click(saveButton());
    await settle();
    expect(screen.getByRole("alert").textContent).toBe("Det gick inte att spara. Försök igen.");
    expect(screen.getByText("Notiser är av för den här enheten.")).toBeTruthy();
    expect(window.localStorage.getItem("kronkoll.push-topics")).toBeNull();
  });

  it.each([
    ["servern saknar nycklar", [200, { configured: false, public_key: null, topics: [] }], true, "Notiser är inte påslagna på servern än."],
    ["servern svarar inte", [503, { error: "unavailable" }], true, "Det gick inte att hämta inställningen för notiser."],
    ["webbläsaren saknar stöd", [200, { configured: true, public_key: "BPUB", topics: [] }], false, /installerad på hemskärmen/u],
  ] as const)("%s: inga reglage, bara en förklaring", async (_, config, available, text) => {
    api(config as [number, unknown]);
    await show(fakeDevice({ available }).device);
    expect(screen.queryAllByRole("switch")).toEqual([]);
    expect(screen.getByText(text)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});