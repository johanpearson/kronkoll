// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { deliverFile } from "./deliver.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const file = new File(["x"], "kronkoll-budget-2026-11.xlsx", { type: "application/octet-stream" });

function stubDownload() {
  const created = vi.fn(() => "blob:test");
  const revoked = vi.fn();
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: created, revokeObjectURL: revoked }));
  const clicks: string[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    clicks.push(`${this.download}|${this.href}`);
  });
  return { created, revoked, clicks };
}

describe("deliverFile (KK-43-C)", () => {
  it("delar filen via telefonens delningsmeny när den går att dela", async () => {
    const share = vi.fn(() => Promise.resolve());
    const result = await deliverFile(file, "Budget", { canShare: () => true, share });
    expect(result).toBe("shared");
    expect(share).toHaveBeenCalledWith({ files: [file], title: "Budget" });
  });

  it("ladda ned när webbläsaren inte kan dela filer, utan att kalla share", async () => {
    const { created, clicks } = stubDownload();
    const share = vi.fn();
    expect(await deliverFile(file, "Budget", { canShare: () => false, share })).toBe("downloaded");
    expect(share).not.toHaveBeenCalled();
    expect(created).toHaveBeenCalledWith(file);
    expect(clicks).toEqual(["kronkoll-budget-2026-11.xlsx|blob:test"]);
    expect(document.querySelector("a")).toBeNull();
  });

  it("ladda ned när delning saknas helt, och släpper adressen efteråt", async () => {
    vi.useFakeTimers();
    const { revoked } = stubDownload();
    expect(await deliverFile(file, "Budget", {})).toBe("downloaded");
    expect(await deliverFile(file, "Budget", { canShare: () => true })).toBe("downloaded");
    expect(revoked).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(revoked).toHaveBeenCalledWith("blob:test");
  });

  it("att stänga delningsmenyn är inget fel och laddar inte ned", async () => {
    const { clicks } = stubDownload();
    const share = vi.fn(() => Promise.reject(new DOMException("avbruten", "AbortError")));
    expect(await deliverFile(file, "Budget", { canShare: () => true, share })).toBe("cancelled");
    expect(clicks).toEqual([]);
  });

  it("ett annat fel i delningen leder till nedladdning", async () => {
    const { clicks } = stubDownload();
    const share = vi.fn(() => Promise.reject(new DOMException("nekad", "NotAllowedError")));
    expect(await deliverFile(file, "Budget", { canShare: () => true, share })).toBe("downloaded");
    expect(clicks).toHaveLength(1);
    const odd = vi.fn(() => Promise.reject(new Error("annat")));
    expect(await deliverFile(file, "Budget", { canShare: () => true, share: odd })).toBe("downloaded");
  });
});
