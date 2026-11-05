import { describe, expect, it } from "vitest";
import { clickTarget, noticeFrom } from "./push.ts";

describe("notis från ett push-meddelande (KK-27)", () => {
  it("visar titel och text och öppnar budgeten för en budgetnotis", () => {
    const payload = JSON.stringify({ title: "Budget överskriden", body: "Mat har passerat budget (104 %)", tag: "budget:2026-11:mat", topic: "budget_over" });
    expect(noticeFrom(payload)).toEqual({
      title: "Budget överskriden",
      options: { body: "Mat har passerat budget (104 %)", tag: "budget:2026-11:mat", icon: "/icons/icon-192.png", badge: "/icons/icon-192.png", data: { url: "/budget" } },
    });
  });

  it.each([
    ["sync_failed", "/installningar"],
    ["consent", "/installningar"],
    ["okand", "/"],
  ])("typen %s öppnar %s", (topic, url) => {
    expect(noticeFrom(JSON.stringify({ title: "t", body: "b", tag: "x", topic })).options.data.url).toBe(url);
  });

  it.each([null, "inte json", "[]", "null", JSON.stringify({ title: "", body: 3 })])("trasigt innehåll (%s) ger en neutral notis", (payload) => {
    const shown = noticeFrom(payload);
    expect([shown.title, shown.options.body, shown.options.tag, shown.options.data.url]).toEqual(["Kronkoll", "Öppna appen för att se mer.", "kronkoll", "/"]);
  });

  it("kortar mycket lång text", () => {
    expect(noticeFrom(JSON.stringify({ title: "t", body: "x".repeat(1000) })).options.body).toHaveLength(300);
  });
});

describe("tryck på notisen", () => {
  it("öppnar bara kända vyer på appens egen adress", () => {
    expect(clickTarget({ url: "/budget" }, "https://kronkoll.example")).toBe("https://kronkoll.example/budget");
    expect(clickTarget({ url: "https://evil.example/" }, "https://kronkoll.example")).toBe("https://kronkoll.example/");
    expect(clickTarget(null, "https://kronkoll.example")).toBe("https://kronkoll.example/");
    expect(clickTarget({ url: 1 }, "https://kronkoll.example")).toBe("https://kronkoll.example/");
  });
});
