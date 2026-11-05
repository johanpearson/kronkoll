import type { D1Database } from "@cloudflare/workers-types";
import { accountRepository, budgetRepository, connectionRepository, deriveKeys, pushRepository, type Keys } from "@kronkoll/adapter-d1";
import { migratedDb, randomSecret } from "@kronkoll/adapter-d1/test-support";
import { fixedClock, type Notice, type NotificationTopic } from "@kronkoll/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { notifyBudgetOver, notifySyncFailure, remindConsent, webPushFrom, type PushSender } from "./notify.ts";
import { captureLogs } from "./test-support.ts";

let db: D1Database;
let dispose: () => Promise<void>;
let keys: Keys;

beforeAll(async () => {
  ({ db, dispose } = await migratedDb());
  keys = await deriveKeys(randomSecret());
  await connectionRepository(db, keys).create({ id: "c1", provider: "enablebanking", aspspName: "Skandia" });
  await accountRepository(db, keys).upsertFromBank({ connectionId: "c1", providerUid: "u1", iban: null, name: "Privatkonto", type: "checking", balanceMinor: 0 }, () => "acc_1");
  // Påhittade köp (KK-13): 520 kr mat och 50 kr okategoriserat i november.
  await db
    .prepare(
      `INSERT INTO transactions (id, account_id, fingerprint, status, last_seen_at, transaction_date, booking_date, amount_minor, category_id, category_source, is_internal_transfer)
       VALUES ('t1', 'acc_1', 'fp', 'booked', '2026-11-03', '2026-11-03', '2026-11-03', -52000, 'mat-livsmedel', 'template', 0),
              ('t2', 'acc_1', 'fp', 'booked', '2026-11-04', '2026-11-04', '2026-11-04', -5000, NULL, 'none', 0)`,
    )
    .run();
});
afterAll(async () => {
  await dispose();
});
beforeEach(async () => {
  await db.batch([db.prepare(`DELETE FROM push_subscriptions`), db.prepare(`DELETE FROM sent_notices`), db.prepare(`DELETE FROM budget_lines`)]);
});

const NOW = "2026-11-15T10:00:00.000Z";

function fakeSender() {
  const sent: Notice[] = [];
  const sender: PushSender = {
    deliver(notice) {
      sent.push(notice);
      return Promise.resolve({ sent: 1, gone: 0, failed: 0 });
    },
  };
  return { sent, sender };
}

function deps(now = NOW) {
  const logs = captureLogs();
  return { logs, deps: { logger: logs.logger, clock: fixedClock(now) } };
}

async function subscribe(topics: NotificationTopic[]) {
  await pushRepository(db).save({ id: "p1", endpoint: "https://web.push.apple.com/exempel", p256dh: `B${"A".repeat(86)}`, auth: "A".repeat(22), topics });
}

describe("budgetnotis efter synken (KK-27-A)", () => {
  it("skickar en notis per kategori som passerat budget, bara en gång i perioden och utan belopp", async () => {
    await subscribe(["budget_over"]);
    await budgetRepository(db).replace("2026-11", [{ categoryId: "mat-livsmedel", amountMinor: 50_000 }], "manual");
    const { sent, sender } = fakeSender();
    const { deps: d, logs } = deps();
    await notifyBudgetOver(db, d, sender);
    await notifyBudgetOver(db, d, sender);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ topic: "budget_over", tag: "budget:2026-11:mat-livsmedel" });
    expect(sent[0]?.body).toMatch(/har passerat budget \(104 %\)$/u);
    expect(sent[0]?.body).not.toMatch(/kr|520/u);
    expect(logs.lines.map((l) => [l.event, l.fields])).toEqual([["push.sent", { kind: "budget_over", count: 1, removed_count: 0, error_code: null }]]);
  });

  it("under budget ger ingen notis", async () => {
    await subscribe(["budget_over"]);
    await budgetRepository(db).replace("2026-11", [{ categoryId: "mat-livsmedel", amountMinor: 60_000 }], "manual");
    const { sent, sender } = fakeSender();
    await notifyBudgetOver(db, deps().deps, sender);
    expect(sent).toEqual([]);
  });

  it("utan någon enhet som valt budgetnotiser räknas inget och inget markeras som skickat", async () => {
    await subscribe(["consent"]);
    await budgetRepository(db).replace("2026-11", [{ categoryId: "mat-livsmedel", amountMinor: 50_000 }], "manual");
    const { sent, sender } = fakeSender();
    await notifyBudgetOver(db, deps().deps, sender);
    expect(sent).toEqual([]);
    expect(await pushRepository(db).budgetNoticesSent("2026-11")).toEqual([]);
  });
});

describe("notis om upprepade synkfel (KK-7-B)", () => {
  it("skickas till enheter som valt typen, med bankens namn eller 'banken'", async () => {
    await subscribe(["sync_failed"]);
    const { sent, sender } = fakeSender();
    await notifySyncFailure(db, deps().deps, sender, "c1", "Skandia");
    await notifySyncFailure(db, deps().deps, sender, "c2", null);
    expect(sent.map((n) => n.body)).toEqual([
      "Synken mot Skandia har misslyckats 3 gånger i rad. Öppna appen för att se mer.",
      "Synken mot banken har misslyckats 3 gånger i rad. Öppna appen för att se mer.",
    ]);
  });

  it("skickas inte när ingen valt typen", async () => {
    await subscribe(["budget_over"]);
    const { sent, sender } = fakeSender();
    await notifySyncFailure(db, deps().deps, sender, "c1", "Skandia");
    expect(sent).toEqual([]);
  });
});

describe("samtyckespåminnelser (KK-27-B)", () => {
  beforeEach(async () => {
    await connectionRepository(db, keys).activate("c1", { sessionId: "sess-exempel", consentExpiresOn: "2026-11-18" });
  });

  it("påminner en gång per gräns: 3 dagar kvar ger en notis, samma dag igen ingen", async () => {
    await subscribe(["consent"]);
    const { sent, sender } = fakeSender();
    await remindConsent(db, deps().deps, sender);
    await remindConsent(db, deps().deps, sender);
    expect(sent.map((n) => [n.tag, n.body])).toEqual([["consent:c1", "Kopplingen till Skandia går ut om 3 dagar (18 nov. 2026). Koppla om i appen."]]);
    expect(await pushRepository(db).consentRemindersSent("c1", "2026-11-18")).toEqual([3, 14]);
  });

  it("utgångsdagen ger nästa påminnelse", async () => {
    await subscribe(["consent"]);
    await pushRepository(db).markConsentRemindersSent("c1", "2026-11-18", [14, 3]);
    const { sent, sender } = fakeSender();
    await remindConsent(db, deps("2026-11-18T06:00:00.000Z").deps, sender);
    expect(sent.map((n) => n.body)).toEqual(["Kopplingen till Skandia går ut i dag (18 nov. 2026). Koppla om i appen."]);
  });

  it("utgångna kopplingar och kopplingar långt från utgång påminns inte", async () => {
    await subscribe(["consent"]);
    const { sent, sender } = fakeSender();
    await remindConsent(db, deps("2026-10-01T06:00:00.000Z").deps, sender);
    await connectionRepository(db, keys).expire("c1");
    await remindConsent(db, deps().deps, sender);
    expect(sent).toEqual([]);
  });

  it("utan någon enhet som valt typen markeras inget", async () => {
    const { sent, sender } = fakeSender();
    await remindConsent(db, deps().deps, sender);
    expect(sent).toEqual([]);
    expect(await pushRepository(db).consentRemindersSent("c1", "2026-11-18")).toEqual([]);
  });
});

describe("Web Push i drift", () => {
  const vapidKeys = async () => {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])) as CryptoKeyPair;
    const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
    const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
    return { VAPID_PUBLIC_KEY: btoa(String.fromCharCode(...raw)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, ""), VAPID_PRIVATE_KEY: jwk.d ?? "" };
  };

  it("skapas bara när båda nycklarna och appens adress finns", async () => {
    const vapid = await vapidKeys();
    expect(webPushFrom({ DB: db, ...vapid, APP_ORIGIN: "https://kronkoll.example" })).not.toBeNull();
    expect(webPushFrom({ DB: db, ...vapid })).toBeNull();
    expect(webPushFrom({ DB: db, VAPID_PUBLIC_KEY: vapid.VAPID_PUBLIC_KEY, APP_ORIGIN: "https://kronkoll.example" })).toBeNull();
    expect(webPushFrom({ DB: db, ...vapid, VAPID_PUBLIC_KEY: "trasig", APP_ORIGIN: "https://kronkoll.example" })).toBeNull();
  });
});
