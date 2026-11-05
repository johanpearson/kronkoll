import type { D1Database } from "@cloudflare/workers-types";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pushRepository, type PushSubscriptionRecord } from "./push.ts";
import { migratedDb } from "./test-support.ts";

let db: D1Database;
let dispose: () => Promise<void>;

beforeAll(async () => {
  ({ db, dispose } = await migratedDb());
});
afterAll(async () => {
  await dispose();
});
beforeEach(async () => {
  await db.batch([db.prepare(`DELETE FROM push_subscriptions`), db.prepare(`DELETE FROM sent_notices`)]);
});

/** Påhittade prenumerationer; nycklarna har rätt längd men är inga riktiga nycklar. */
const phone: PushSubscriptionRecord = {
  id: "p1",
  endpoint: "https://web.push.apple.com/exempel-1",
  p256dh: `B${"A".repeat(86)}`,
  auth: "A".repeat(22),
  topics: ["consent", "budget_over"],
};
const laptop: PushSubscriptionRecord = { ...phone, id: "p2", endpoint: "https://fcm.googleapis.com/fcm/send/exempel-2", topics: ["sync_failed"] };

describe("push-prenumerationer i D1 (KK-27)", () => {
  it("sparar prenumerationer och läser dem med valda notistyper", async () => {
    const repo = pushRepository(db);
    expect(await repo.save(phone)).toBe("p1");
    expect(await repo.save(laptop)).toBe("p2");
    expect(await repo.list()).toEqual([phone, laptop]);
  });

  it("samma adress igen ändrar nycklar och typer men behåller id:t", async () => {
    const repo = pushRepository(db);
    await repo.save(phone);
    expect(await repo.save({ ...phone, id: "nytt", auth: "B".repeat(22), topics: ["sync_failed"] })).toBe("p1");
    expect(await repo.list()).toEqual([{ ...phone, auth: "B".repeat(22), topics: ["sync_failed"] }]);
  });

  it("tar bort med id eller adress och säger till om den inte fanns", async () => {
    const repo = pushRepository(db);
    await repo.save(phone);
    await repo.save(laptop);
    expect(await repo.remove("p1")).toBe(true);
    expect(await repo.remove("p1")).toBe(false);
    expect(await repo.removeByEndpoint(laptop.endpoint)).toBe(true);
    expect(await repo.removeByEndpoint(laptop.endpoint)).toBe(false);
    expect(await repo.list()).toEqual([]);
  });

  it("okända notistyper i databasen ignoreras i stället för att skickas", async () => {
    await db.prepare(`INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, topics) VALUES ('p3', 'https://web.push.apple.com/x', 'k', 'a', '["sms","consent"]')`).run();
    expect((await pushRepository(db).list())[0]?.topics).toEqual([]);
  });

  it.each([
    ["http-adress", { endpoint: "http://web.push.apple.com/x" }],
    ["för lång nyckel", { p256dh: "A".repeat(101) }],
  ])("databasen avvisar %s", async (_, change) => {
    await expect(pushRepository(db).save({ ...phone, ...change })).rejects.toThrow();
  });

  it("databasen avvisar typer som inte är en JSON-lista", async () => {
    await expect(
      db.prepare(`INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, topics) VALUES ('p4', 'https://web.push.apple.com/y', 'k', 'a', '{"a":1}')`).run(),
    ).rejects.toThrow();
  });
});

describe("skickade notiser (KK-27-A, KK-27-B)", () => {
  it("minns budgetnotiser per period och kategori", async () => {
    const repo = pushRepository(db);
    expect(await repo.budgetNoticesSent("2026-11")).toEqual([]);
    await repo.markBudgetNoticesSent("2026-11", ["mat", "noje"]);
    await repo.markBudgetNoticesSent("2026-11", ["mat"]);
    await repo.markBudgetNoticesSent("2026-12", ["bil"]);
    expect(await repo.budgetNoticesSent("2026-11")).toEqual(["mat", "noje"]);
    expect(await repo.budgetNoticesSent("2026-12")).toEqual(["bil"]);
  });

  it("minns samtyckespåminnelser per koppling och utgångsdag, så att ett nytt samtycke börjar om", async () => {
    const repo = pushRepository(db);
    await repo.markConsentRemindersSent("c1", "2027-05-01", [14, 3]);
    await repo.markConsentRemindersSent("c1", "2027-05-01", [3, 0]);
    expect(await repo.consentRemindersSent("c1", "2027-05-01")).toEqual([0, 3, 14]);
    expect(await repo.consentRemindersSent("c1", "2027-11-01")).toEqual([]);
    expect(await repo.consentRemindersSent("c2", "2027-05-01")).toEqual([]);
  });

  it("en tom lista skriver ingenting", async () => {
    const repo = pushRepository(db);
    await repo.markBudgetNoticesSent("2026-11", []);
    await repo.markConsentRemindersSent("c1", "2027-05-01", []);
    expect(await db.prepare(`SELECT count(*) AS n FROM sent_notices`).first("n")).toBe(0);
  });
});
