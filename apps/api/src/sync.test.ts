import type { D1Database } from "@cloudflare/workers-types";
import { accountRepository, connectionRepository, deriveKeys, pushRepository, type Keys } from "@kronkoll/adapter-d1";
import { migratedDb, randomSecret } from "@kronkoll/adapter-d1/test-support";
import { fixedClock, ProviderError, type BankDataProvider, type Notice, type ProviderTransaction } from "@kronkoll/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PushSender } from "./notify.ts";
import { runSync, type SyncDeps } from "./sync.ts";
import { captureLogs } from "./test-support.ts";

let db: D1Database;
let dispose: () => Promise<void>;
let secret: string;
let keys: Keys;

beforeAll(async () => {
  ({ db, dispose } = await migratedDb());
  secret = randomSecret();
  keys = await deriveKeys(secret);
});
afterAll(async () => {
  await dispose();
});

// Påhittade värden, formade som Enable Bankings (KK-13).
const SESSION_ID = "3f1d2c4b-0000-4000-8000-00000000abcd";
const NOW = "2026-11-20T04:07:00.000Z";

let seq = 0;
const newId = () => `id-${String(++seq)}`;

function bankTx(overrides: Partial<ProviderTransaction> = {}): ProviderTransaction {
  return {
    providerTxId: "t1",
    status: "booked",
    transactionDate: "2026-11-18",
    bookingDate: "2026-11-18",
    amountMinor: -4500,
    counterparty: "K*ESPRESSO HOUSE 123 STHLM",
    description: "Kaffe med kollegor",
    ...overrides,
  };
}

function fakeBank(behaviour: { transactions?: ProviderTransaction[] | ProviderError; balance?: number | null } = {}): BankDataProvider {
  return {
    accounts: () => Promise.resolve([]),
    balance: () => Promise.resolve(behaviour.balance === undefined ? 1_250_050 : behaviour.balance),
    transactions() {
      const t = behaviour.transactions ?? [bankTx()];
      return t instanceof ProviderError ? Promise.reject(t) : Promise.resolve({ transactions: t, continuationKey: null });
    },
  };
}

function setup(provider: BankDataProvider | null = fakeBank()) {
  const logs = captureLogs();
  const deps: SyncDeps = { logger: logs.logger, clock: fixedClock(NOW), newId, providerFor: () => provider };
  return { deps, logs };
}

const env = () => ({ DB: db, SESSION_ENC_KEY: secret });

async function seedConnection(id: string, provider: "enablebanking" | "csv" = "enablebanking") {
  const connections = connectionRepository(db, keys);
  await connections.create({ id, provider, aspspName: "Skandia" });
  await connections.activate(id, { sessionId: SESSION_ID, consentExpiresOn: "2027-04-30" });
  const accounts = accountRepository(db, keys);
  const accountId = await accounts.upsertFromBank(
    { connectionId: id, providerUid: `uid-${id}`, iban: null, name: "Privatkonto", type: "checking", balanceMinor: null },
    newId,
  );
  return accountId;
}

async function reset() {
  await db.batch([db.prepare(`DELETE FROM sync_runs`), db.prepare(`DELETE FROM transactions`), db.prepare(`DELETE FROM accounts`), db.prepare(`DELETE FROM bank_connections`)]);
}
beforeEach(reset);

const count = async (table: string) => (await db.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())?.n;

describe("schemalagd synk (KK-7-A, V-i-sync)", () => {
  it("hämtar, sparar transaktioner och saldo, loggar körningen och sparar tidpunkten för senaste lyckade synk", async () => {
    const accountId = await seedConnection("c1");
    const { deps, logs } = setup();
    await runSync(env(), "cron", deps);

    const tx = await db.prepare(`SELECT counterparty, counterparty_norm AS norm, amount_minor AS amount, status FROM transactions`).first();
    expect(tx).toEqual({ counterparty: "K*ESPRESSO HOUSE 123 STHLM", norm: "ESPRESSO HOUSE", amount: -4500, status: "booked" });
    expect((await db.prepare(`SELECT balance_minor AS b FROM accounts WHERE id = ?`).bind(accountId).first<{ b: number }>())?.b).toBe(1_250_050);
    expect(await db.prepare(`SELECT kind, status, new_count AS n, error_code AS e FROM sync_runs`).first()).toEqual({ kind: "cron", status: "ok", n: 1, e: null });
    expect(await db.prepare(`SELECT last_success_at AS at, consecutive_failures AS f FROM bank_connections`).first()).toEqual({ at: NOW, f: 0 });
    expect(logs.lines.map((l) => l.event)).toEqual(["sync.finished"]);
    expect(logs.lines[0]?.fields).toMatchObject({ connection_id: "c1", status: "ok", new_count: 1, updated_count: 0 });
  });

  it("en andra körning samma dag lägger inte till något", async () => {
    await seedConnection("c1");
    const { deps } = setup();
    await runSync(env(), "cron", deps);
    await runSync(env(), "manual", deps);
    expect(await count("transactions")).toBe(1);
    expect(await db.prepare(`SELECT status, new_count AS n, updated_count AS u FROM sync_runs WHERE kind = 'manual'`).first()).toEqual({ status: "ok", n: 0, u: 0 });
  });

  it("loggarna innehåller aldrig bankens text eller belopp (KK-13-A)", async () => {
    await seedConnection("c1");
    const { deps, logs } = setup();
    await runSync(env(), "cron", deps);
    const everything = JSON.stringify(logs.lines);
    for (const forbidden of ["ESPRESSO", "Kaffe", "4500", "1250050", SESSION_ID]) expect(everything).not.toContain(forbidden);
  });

  it("synkar varje aktiv Enable Banking-koppling och hoppar över CSV-kopplingar", async () => {
    await seedConnection("c1");
    await seedConnection("c2");
    await seedConnection("csv1", "csv");
    const { deps } = setup();
    await runSync(env(), "cron", deps);
    const runs = await db.prepare(`SELECT connection_id AS c FROM sync_runs ORDER BY c`).all<{ c: string }>();
    expect(runs.results.map((r) => r.c)).toEqual(["c1", "c2"]);
  });
});

describe("kategorisering efter synken (KK-18, F-dataflode)", () => {
  it("sätter mallkategorin på nya transaktioner och lämnar dem utan träff okategoriserade", async () => {
    await seedConnection("c1");
    const { deps, logs } = setup(
      fakeBank({ transactions: [bankTx({ providerTxId: "ica", counterparty: "ICA NARA SOFO 1234 STHLM" }), bankTx({ providerTxId: "kaffe" })] }),
    );
    await runSync(env(), "cron", deps);
    const rows = await db.prepare(`SELECT counterparty_norm AS norm, category_id AS c, category_source AS s FROM transactions ORDER BY norm`).all();
    expect(rows.results).toEqual([
      { norm: "ESPRESSO HOUSE", c: null, s: "none" },
      { norm: "ICA NARA SOFO", c: "mat-livsmedel", s: "template" },
    ]);
    expect(logs.lines.at(-1)).toEqual({ level: "info", event: "sync.categorized", fields: { count: 1 } });
  });

  it("kategoriserar ett kortköp där banken bara skickar butiken i beskrivningen", async () => {
    await seedConnection("c1");
    const { deps } = setup(fakeBank({ transactions: [bankTx({ providerTxId: "kort", counterparty: "", description: "K*ICA NARA SOFO 4711 STHLM" })] }));
    await runSync(env(), "cron", deps);
    // Motparten är fortfarande tom, så avstämningen mot banken fungerar som förut.
    expect(await db.prepare(`SELECT counterparty_norm AS norm, category_id AS c, category_source AS s FROM transactions`).first()).toEqual({ norm: "", c: "mat-livsmedel", s: "template" });
  });

  it("rör aldrig en manuellt satt kategori, och inte heller en som redan har kategori (KK-18-C)", async () => {
    await seedConnection("c1");
    const { deps } = setup(fakeBank({ transactions: [bankTx({ providerTxId: "ica", counterparty: "ICA NARA SOFO" })] }));
    await runSync(env(), "cron", deps);
    await db.prepare(`UPDATE transactions SET category_id = 'hushall-forbrukning', category_source = 'manual'`).run();
    await runSync(env(), "manual", deps);
    expect(await db.prepare(`SELECT category_id AS c, category_source AS s FROM transactions`).first()).toEqual({ c: "hushall-forbrukning", s: "manual" });
  });

  it("kategoriserar även äldre transaktioner som saknar kategori, till exempel från före den här funktionen", async () => {
    await seedConnection("c1");
    const { deps } = setup(fakeBank({ transactions: [] }));
    await db
      .prepare(
        `INSERT INTO transactions (id, account_id, fingerprint, status, last_seen_at, transaction_date, amount_minor, counterparty, counterparty_norm)
         SELECT 'gammal', id, 'fp', 'booked', '2026-10-01', '2026-10-01', -300, 'SL', 'SL' FROM accounts LIMIT 1`,
      )
      .run();
    await runSync(env(), "cron", deps);
    expect(await db.prepare(`SELECT category_id AS c FROM transactions WHERE id = 'gammal'`).first()).toEqual({ c: "transport-kollektivtrafik" });
  });
});

describe("inkomstklassning efter synken (KK-22-A)", () => {
  it("klassar Försäkringskassan, lön och övrigt i meddelandet, och rör aldrig en manuell klassning", async () => {
    await seedConnection("c1");
    const { deps, logs } = setup(
      fakeBank({
        transactions: [
          bankTx({ providerTxId: "fk", amountMinor: 1_500_000, counterparty: "", description: "FÖRSÄKRINGSKASSAN" }),
          bankTx({ providerTxId: "lon", amountMinor: 3_300_000, counterparty: "", description: "LÖN EXEMPEL AB" }),
          bankTx({ providerTxId: "swish", amountMinor: 20_000, counterparty: "", description: "Swish från Anna" }),
          bankTx({ providerTxId: "kaffe" }),
        ],
      }),
    );
    await runSync(env(), "cron", deps);
    const rows = () => db.prepare(`SELECT provider_tx_id AS id, income_type AS t, income_source AS s FROM transactions ORDER BY id`).all();
    expect((await rows()).results).toEqual([
      { id: "fk", t: "parental_benefit", s: "template" },
      { id: "kaffe", t: null, s: "none" },
      { id: "lon", t: "salary", s: "template" },
      { id: "swish", t: "other", s: "none" },
    ]);
    expect(logs.lines.at(-1)).toEqual({ level: "info", event: "sync.income_classified", fields: { count: 3 } });
    await db.prepare(`UPDATE transactions SET income_type = 'other', income_source = 'manual' WHERE provider_tx_id = 'lon'`).run();
    await runSync(env(), "manual", deps);
    expect((await rows()).results).toContainEqual({ id: "lon", t: "other", s: "manual" });
  });
});

describe("interna överföringar efter synken (KK-20-C, F-dataflode)", () => {
  /** Påhittade transaktioner (KK-13) direkt i databasen, en per konto och dag. */
  async function insert(id: string, accountId: string, amount: number, date = "2026-11-02") {
    await db
      .prepare(
        `INSERT INTO transactions (id, account_id, fingerprint, status, last_seen_at, transaction_date, amount_minor, counterparty, counterparty_norm)
         VALUES (?, ?, 'fp', 'booked', ?, ?, ?, 'X', 'X')`,
      )
      .bind(id, accountId, date, date, amount)
      .run();
  }
  const flags = async () =>
    (await db.prepare(`SELECT id, is_internal_transfer AS i, transfer_pair_id AS p FROM transactions ORDER BY id`).all()).results;

  it("markerar en överföring mellan två egna konton som intern, åt båda hållen, och rör inte ett vanligt köp", async () => {
    const budget = await seedConnection("c1");
    const spar = await seedConnection("c2");
    await insert("ut", budget, -500000);
    await insert("in", spar, 500000, "2026-11-03");
    await insert("kop", budget, -4500);
    const { deps, logs } = setup(fakeBank({ transactions: [] }));
    await runSync(env(), "cron", deps);
    expect(await flags()).toEqual([
      { id: "in", i: 1, p: "ut" },
      { id: "kop", i: 0, p: null },
      { id: "ut", i: 1, p: "in" },
    ]);
    expect(logs.lines.at(-1)).toEqual({ level: "info", event: "sync.transfers", fields: { count: 2 } });
  });

  it("en ny synk utan ändringar skriver och loggar ingenting om överföringar", async () => {
    const budget = await seedConnection("c1");
    const spar = await seedConnection("c2");
    await insert("ut", budget, -500000);
    await insert("in", spar, 500000);
    const { deps, logs } = setup(fakeBank({ transactions: [] }));
    await runSync(env(), "cron", deps);
    const before = logs.lines.length;
    await runSync(env(), "cron", deps);
    expect(logs.lines.slice(before).map((l) => l.event)).not.toContain("sync.transfers");
  });

  it("belopp som inte möts inom tre dagar räknas inte som överföring", async () => {
    const budget = await seedConnection("c1");
    const spar = await seedConnection("c2");
    await insert("ut", budget, -500000, "2026-11-01");
    await insert("in", spar, 500000, "2026-11-05");
    const { deps } = setup(fakeBank({ transactions: [] }));
    await runSync(env(), "cron", deps);
    expect((await flags()).map((r) => r.i)).toEqual([0, 0]);
  });
});

describe("fel isoleras (KK-7-B)", () => {
  it("401 från banken sätter kopplingen till utgången och loggar felkoden", async () => {
    await seedConnection("c1");
    const { deps, logs } = setup(fakeBank({ transactions: new ProviderError("UNAUTHORIZED") }));
    await runSync(env(), "cron", deps);
    expect((await db.prepare(`SELECT status FROM bank_connections`).first<{ status: string }>())?.status).toBe("expired");
    expect(await db.prepare(`SELECT status, error_code AS e FROM sync_runs`).first()).toEqual({ status: "failed", e: "CONSENT_EXPIRED" });
    expect(logs.lines.map((l) => l.event)).toEqual(["sync.finished", "sync.consent_expired"]);
  });

  it("rate limit på en koppling stoppar inte nästa, och försöker igen nästa körning", async () => {
    await seedConnection("c1");
    await seedConnection("c2");
    let call = 0;
    const flaky: BankDataProvider = {
      ...fakeBank(),
      transactions() {
        call += 1;
        return call === 1 ? Promise.reject(new ProviderError("RATE_LIMITED")) : Promise.resolve({ transactions: [bankTx()], continuationKey: null });
      },
    };
    const { deps } = setup(flaky);
    await runSync(env(), "cron", deps);
    const runs = await db.prepare(`SELECT connection_id AS c, status, error_code AS e FROM sync_runs ORDER BY c`).all();
    expect(runs.results).toEqual([
      { c: "c1", status: "failed", e: "EB_429" },
      { c: "c2", status: "ok", e: null },
    ]);
    expect((await db.prepare(`SELECT status FROM bank_connections WHERE id = 'c1'`).first<{ status: string }>())?.status).toBe("active");
  });

  it("tredje misslyckade körningen i rad loggar att en felnotis ska skickas", async () => {
    await seedConnection("c1");
    const { deps, logs } = setup(fakeBank({ transactions: new ProviderError("UNAVAILABLE") }));
    for (let i = 0; i < 3; i++) await runSync(env(), "cron", deps);
    expect(logs.lines.filter((l) => l.event === "sync.failure_notice")).toHaveLength(1);
    expect((await db.prepare(`SELECT consecutive_failures AS f FROM bank_connections`).first<{ f: number }>())?.f).toBe(3);
  });

  it("ett oväntat fel i en koppling loggas som felkod och stoppar inte de andra", async () => {
    await seedConnection("c1");
    await seedConnection("c2");
    let first = true;
    const { deps, logs } = setup();
    const throwing: SyncDeps = {
      ...deps,
      newId: () => {
        if (first) {
          first = false;
          throw new Error("konto 1234 är spärrat");
        }
        return newId();
      },
    };
    await runSync(env(), "cron", throwing);
    expect(logs.lines.map((l) => l.event)).toEqual(["sync.connection_failed", "sync.finished"]);
    expect(JSON.stringify(logs.lines)).not.toContain("1234");
  });
});

describe("notiser efter synken (KK-27)", () => {
  function pushSpy(fail = false) {
    const sent: Notice[] = [];
    const sender: PushSender = {
      deliver(notice) {
        if (fail) return Promise.reject(new Error("push-tjänsten svarar inte"));
        sent.push(notice);
        return Promise.resolve({ sent: 1, gone: 0, failed: 0 });
      },
    };
    return { sent, sender };
  }

  beforeEach(async () => {
    await db.batch([db.prepare(`DELETE FROM push_subscriptions`), db.prepare(`DELETE FROM sent_notices`)]);
    await pushRepository(db).save({ id: "p1", endpoint: "https://web.push.apple.com/exempel", p256dh: `B${"A".repeat(86)}`, auth: "A".repeat(22), topics: ["consent", "sync_failed", "budget_over"] });
  });

  it("tredje misslyckade körningen skickar en notis om synkfel", async () => {
    await seedConnection("c1");
    const { sent, sender } = pushSpy();
    const { deps } = setup(fakeBank({ transactions: new ProviderError("UNAVAILABLE") }));
    for (let i = 0; i < 4; i++) await runSync(env(), "cron", { ...deps, pushFor: () => sender });
    expect(sent.map((n) => n.tag)).toEqual(["sync:c1"]);
  });

  it("den schemalagda synken påminner om samtycket, den manuella inte", async () => {
    await seedConnection("c1");
    await db.prepare(`UPDATE bank_connections SET consent_expires_on = '2026-11-23'`).run();
    const { sent, sender } = pushSpy();
    const { deps } = setup();
    await runSync(env(), "manual", { ...deps, pushFor: () => sender });
    expect(sent).toEqual([]);
    await runSync(env(), "cron", { ...deps, pushFor: () => sender });
    expect(sent.map((n) => n.tag)).toEqual(["consent:c1"]);
  });

  it("utan Web Push skickas inget, och ett fel i leveransen stoppar inte synken", async () => {
    await seedConnection("c1");
    await db.prepare(`UPDATE bank_connections SET consent_expires_on = '2026-11-23'`).run();
    const { deps, logs } = setup();
    await runSync(env(), "cron", { ...deps, pushFor: () => null });
    await runSync(env(), "cron", { ...deps, pushFor: () => pushSpy(true).sender });
    expect(logs.lines.filter((l) => l.event === "push.failed")).toEqual([expect.objectContaining({ fields: { error_code: "FAILED" } })]);
    expect(await count("sync_runs")).toBe(2);
  });
});

describe("saknade inställningar och databasfel", () => {
  it.each([
    ["SESSION_ENC_KEY saknas", () => ({ DB: db })],
    ["SESSION_ENC_KEY är ogiltig", () => ({ DB: db, SESSION_ENC_KEY: "inte-base64-!!" })],
  ])("%s: loggar och rör ingenting", async (_, makeEnv) => {
    await seedConnection("c1");
    const { deps, logs } = setup();
    await runSync(makeEnv(), "cron", deps);
    expect(logs.lines.map((l) => l.event)).toEqual(["sync.not_configured"]);
    expect(await count("sync_runs")).toBe(0);
  });

  it("saknade bankhemligheter (ingen provider) loggar och rör ingenting", async () => {
    await seedConnection("c1");
    const { deps, logs } = setup(null);
    await runSync(env(), "cron", deps);
    expect(logs.lines.map((l) => l.event)).toEqual(["sync.not_configured"]);
    expect(await count("sync_runs")).toBe(0);
  });

  it("om databasen inte går att läsa loggas en felkod och funktionen kastar inte", async () => {
    const { deps, logs } = setup();
    const broken = { prepare: () => { throw new Error("D1 nere"); } } as unknown as D1Database;
    await expect(runSync({ DB: broken, SESSION_ENC_KEY: secret }, "cron", deps)).resolves.toBeUndefined();
    expect(logs.lines.map((l) => l.event)).toEqual(["sync.failed"]);
  });
});
