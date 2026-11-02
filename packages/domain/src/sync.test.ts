import { describe, expect, it } from "vitest";
import {
  classifyProviderFailure,
  manualSyncGate,
  nextConsecutiveFailures,
  shouldNotifySyncFailure,
  summarizeSyncRun,
  syncDateFrom,
} from "./sync.ts";

describe("hämtningens startdatum (KK-7-A)", () => {
  it("går 10 dagar bakåt från senaste bokförda, så att sena bokningar fångas", () => {
    expect(syncDateFrom("2026-11-10")).toBe("2026-10-31");
  });

  it("ger null före första hämtningen, så att adaptern hämtar så långt bakåt banken tillåter", () => {
    expect(syncDateFrom(null)).toBeNull();
  });

  it("avvisar ogiltigt datum", () => {
    expect(() => syncDateFrom("2026-13-40")).toThrow();
  });
});

describe("manuell synk högst en gång per 15 minuter (KK-7-C)", () => {
  const now = new Date("2026-11-02T10:15:00Z");

  it("tillåts när ingen manuell synk har körts", () => {
    expect(manualSyncGate(null, now)).toEqual({ allowed: true });
  });

  it("nekas inom 15 minuter och anger hur många sekunder som återstår", () => {
    expect(manualSyncGate(new Date("2026-11-02T10:06:00Z"), now)).toEqual({ allowed: false, retryAfterSeconds: 360 });
  });

  it("tillåts när exakt 15 minuter har gått", () => {
    expect(manualSyncGate(new Date("2026-11-02T10:00:00Z"), now)).toEqual({ allowed: true });
  });

  it("tillåts om klockan har gått bakåt, så att en felaktig tid aldrig låser användaren ute", () => {
    expect(manualSyncGate(new Date("2026-11-02T11:00:00Z"), now)).toEqual({ allowed: true });
  });
});

describe("fel från banken per konto (KK-7-B)", () => {
  it.each([
    ["UNAUTHORIZED", "CONSENT_EXPIRED", "expire_connection"],
    ["RATE_LIMITED", "EB_429", "retry_next_run"],
    ["UNAVAILABLE", "EB_UNAVAILABLE", "retry_next_run"],
    ["BAD_RESPONSE", "EB_BAD_RESPONSE", "retry_next_run"],
    ["FAILED", "EB_FAILED", "retry_next_run"],
  ] as const)("%s ger felkod %s och åtgärd %s", (code, errorCode, action) => {
    expect(classifyProviderFailure(code)).toEqual({ errorCode, action });
  });

  it("felkoderna passar databasens kontroll: bara A–Z, 0–9 och understreck", () => {
    for (const code of ["UNAUTHORIZED", "RATE_LIMITED", "UNAVAILABLE", "BAD_RESPONSE", "FAILED"] as const) {
      expect(classifyProviderFailure(code).errorCode).toMatch(/^[A-Z0-9_]+$/u);
    }
  });
});

describe("sammanfattning av en körning (KK-7-A, KK-7-B)", () => {
  it("alla konton lyckades: ok, med summerade antal", () => {
    expect(
      summarizeSyncRun([
        { ok: true, newCount: 3, updatedCount: 1 },
        { ok: true, newCount: 2, updatedCount: 0 },
      ]),
    ).toEqual({ status: "ok", newCount: 5, updatedCount: 1, errorCode: null });
  });

  it("ett konto misslyckades: partial, och de andra kontonas antal räknas ändå", () => {
    expect(
      summarizeSyncRun([
        { ok: true, newCount: 4, updatedCount: 2 },
        { ok: false, error: "RATE_LIMITED" },
      ]),
    ).toEqual({ status: "partial", newCount: 4, updatedCount: 2, errorCode: "EB_429" });
  });

  it("alla konton misslyckades: failed med första felets kod", () => {
    expect(
      summarizeSyncRun([
        { ok: false, error: "UNAVAILABLE" },
        { ok: false, error: "RATE_LIMITED" },
      ]),
    ).toEqual({ status: "failed", newCount: 0, updatedCount: 0, errorCode: "EB_UNAVAILABLE" });
  });

  it("ett utgånget samtycke går före andra fel i felkoden", () => {
    expect(
      summarizeSyncRun([
        { ok: false, error: "RATE_LIMITED" },
        { ok: false, error: "UNAUTHORIZED" },
      ]).errorCode,
    ).toBe("CONSENT_EXPIRED");
  });

  it("en koppling utan konton är ok och ändrar inget", () => {
    expect(summarizeSyncRun([])).toEqual({ status: "ok", newCount: 0, updatedCount: 0, errorCode: null });
  });
});

describe("misslyckade körningar i rad och notis (KK-7-B)", () => {
  it("failed räknar upp, ok och partial nollställer", () => {
    expect(nextConsecutiveFailures(1, "failed")).toBe(2);
    expect(nextConsecutiveFailures(2, "ok")).toBe(0);
    expect(nextConsecutiveFailures(2, "partial")).toBe(0);
  });

  it("notisen skickas när det tredje misslyckandet i rad inträffar, inte före och inte om och om igen", () => {
    expect([0, 1, 2, 3, 4, 5].map(shouldNotifySyncFailure)).toEqual([false, false, false, true, false, false]);
  });
});
