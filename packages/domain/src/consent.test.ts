import { describe, expect, it } from "vitest";
import { consentReminderText, consentStatus, dueConsentReminder } from "./consent.ts";

describe("samtyckets status (KK-8-A, F-conn-state)", () => {
  const status = (expiresOn: string | null, today: string, current: Parameters<typeof consentStatus>[0]["status"] = "active", bankRejected = false) =>
    consentStatus({ status: current, consentExpiresOn: expiresOn, today, bankRejected });

  it.each([
    ["15 dagar kvar: aktiv", "2026-11-16", "active"],
    ["14 dagar kvar: går snart ut", "2026-11-15", "expiring"],
    ["utgångsdagen: går snart ut", "2026-11-01", "expiring"],
    ["dagen efter: utgånget", "2026-10-31", "expired"],
  ])("%s", (_, expiresOn, expected) => {
    expect(status(expiresOn, "2026-11-01")).toBe(expected);
  });

  it("401 från banken ger utgånget oavsett datum", () => {
    expect(status("2027-04-01", "2026-11-01", "active", true)).toBe("expired");
  });

  it("ett utgånget samtycke förblir utgånget tills användaren kopplar om", () => {
    expect(status("2027-04-01", "2026-11-01", "expired")).toBe("expired");
  });

  it("en ny koppling som går ut långt fram blir aktiv igen efter koppla om", () => {
    expect(status("2027-04-30", "2026-11-01", "expiring")).toBe("active");
  });

  it.each(["pending_auth", "revoked", "deleted"] as const)("rör inte status %s", (current) => {
    expect(status("2026-11-02", "2026-11-01", current)).toBe(current);
  });

  it("utan utgångsdatum behålls aktiv", () => {
    expect(status(null, "2026-11-01")).toBe("active");
  });
});

describe("samtyckespåminnelser 14, 3 och 0 dagar före (KK-27-B)", () => {
  it.each([
    [14, "2026-11-15", [], { daysLeft: 14, markSent: [14] }],
    [3, "2026-11-04", [14], { daysLeft: 3, markSent: [3] }],
    [0, "2026-11-01", [14, 3], { daysLeft: 0, markSent: [0] }],
  ])("%i dagar kvar ger en påminnelse när de tidigare redan skickats", (_, expiresOn, alreadySent, expected) => {
    expect(dueConsentReminder({ consentExpiresOn: expiresOn, today: "2026-11-01", alreadySent })).toEqual(expected);
  });

  it("dagar mellan gränserna ger ingen påminnelse när den förra redan skickats", () => {
    expect(dueConsentReminder({ consentExpiresOn: "2026-11-11", today: "2026-11-01", alreadySent: [14] })).toBeNull();
  });

  it("samma påminnelse skickas aldrig två gånger", () => {
    expect(dueConsentReminder({ consentExpiresOn: "2026-11-15", today: "2026-11-01", alreadySent: [14] })).toBeNull();
  });

  it("missade synkdagar ger en enda påminnelse med rätt antal dagar, och båda gränserna markeras", () => {
    expect(dueConsentReminder({ consentExpiresOn: "2026-11-03", today: "2026-11-01", alreadySent: [] })).toEqual({
      daysLeft: 2,
      markSent: [14, 3],
    });
  });

  it("efter utgången skickas inga påminnelser, och utan datum inte heller", () => {
    expect(dueConsentReminder({ consentExpiresOn: "2026-10-31", today: "2026-11-01", alreadySent: [] })).toBeNull();
    expect(dueConsentReminder({ consentExpiresOn: null, today: "2026-11-01", alreadySent: [] })).toBeNull();
  });

  it("mer än 14 dagar kvar ger ingen påminnelse", () => {
    expect(dueConsentReminder({ consentExpiresOn: "2026-11-16", today: "2026-11-01", alreadySent: [] })).toBeNull();
  });
});

describe("text i notis och banner (KK-8-A)", () => {
  it.each([
    [14, "2026-11-15", "Kopplingen till Skandia går ut om 14 dagar (15 nov. 2026). Koppla om i appen."],
    [1, "2026-11-02", "Kopplingen till Skandia går ut i morgon (2 nov. 2026). Koppla om i appen."],
    [0, "2026-11-01", "Kopplingen till Skandia går ut i dag (1 nov. 2026). Koppla om i appen."],
  ])("%i dagar kvar", (daysLeft, expiresOn, text) => {
    expect(consentReminderText("Skandia", daysLeft, expiresOn)).toBe(text);
  });
});
