import { describe, expect, it, vi } from "vitest";
import { registerServiceWorker } from "./pwa.ts";

describe("registerServiceWorker (KK-25-A)", () => {
  it("registrerar /sw.js", () => {
    const register = vi.fn(() => Promise.resolve());
    registerServiceWorker({ serviceWorker: { register } } as unknown as Navigator);
    expect(register).toHaveBeenCalledWith("/sw.js");
  });

  it("gör inget i en webbläsare utan service workers", () => {
    expect(() => {
      registerServiceWorker({} as Navigator);
    }).not.toThrow();
  });

  // Ett ofångat fel skulle Vitest rapportera som ett fel i testkörningen.
  it("fångar felet när registreringen misslyckas", async () => {
    const register = vi.fn(() => Promise.reject(new Error("nekad")));
    registerServiceWorker({ serviceWorker: { register } } as unknown as Navigator);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(register).toHaveBeenCalledOnce();
  });
});
