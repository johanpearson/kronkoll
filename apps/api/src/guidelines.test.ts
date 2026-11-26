import type { D1Database } from "@cloudflare/workers-types";
import { accountRepository, connectionRepository, deriveKeys, settingsRepository } from "@kronkoll/adapter-d1";
import { migratedDb, randomSecret } from "@kronkoll/adapter-d1/test-support";
import { fixedClock } from "@kronkoll/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cachedVerifier, type GuardDeps } from "./access.ts";
import { handle, type Env, type RouteContext } from "./index.ts";
import { AUD, INVITED, ISSUER, ORIGIN, captureLogs, configuredEnv, createTestKey, jwksFetch, signToken, type TestKey } from "./test-support.ts";

let db: D1Database;
let dispose: () => Promise<void>;
let key: TestKey;
let guardDeps: GuardDeps;

beforeAll(async () => {
  ({ db, dispose } = await migratedDb());
  const keys = await deriveKeys(randomSecret());
  key = await createTestKey("budget-key");
  const { fetchImpl } = jwksFetch(key);
  guardDeps = {
    verifierFor: () => cachedVerifier({ issuer: ISSUER, audience: AUD, allowedEmails: [INVITED], appOrigin: ORIGIN }, fetchImpl),
    logger: captureLogs().logger,
  };
  await connectionRepository(db, keys).create({ id: "c1", provider: "enablebanking", aspspName: "Skandia" });
  await accountRepository(db, keys).upsertFromBank({ connectionId: "c1", providerUid: "u1", iban: null, name: "Privatkonto", type: "checking", balanceMinor: 0 }, () => "acc_1");
  // Påhittade transaktioner (KK-13): sex månaders utgifter, hyra som återkommer och tre månaders lön.
  const monthly: Record<string, number[]> = {
    "mat-livsmedel": [6000, 6200, 5800, 6100, 6300, 6400, 3000],
    "fritid-hobby": [1500, 1800, 1200, 2000, 15000, 1600, 3000],
  };
  const months = ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"];
  const rows: [string, string, number, string | null, string, string | null][] = [];
  for (const [category, totals] of Object.entries(monthly)) {
    totals.forEach((total, i) => {
      const month = months[i] ?? "";
      // Två köp per månad, så att varken mat eller hobby ser ut som en återkommande dragning.
      const first = Math.floor(total * 0.4);
      rows.push([`${category}-${month}-a`, `${month}-03`, -first, category, category === "mat-livsmedel" ? "ICA" : "Hobbyhandeln", null]);
      rows.push([`${category}-${month}-b`, `${month}-${month === "2026-11" ? "10" : "17"}`, -(total - first), category, category === "mat-livsmedel" ? "ICA" : "Hobbyhandeln", null]);
    });
  }
  for (const month of months.slice(0, 6)) rows.push([`hyra-${month}`, `${month}-25`, -9000, "boende-hyra-avgift", "Hyresvärden", null]);
  for (const month of ["2026-08", "2026-09", "2026-10"]) rows.push([`lon-${month}`, `${month}-26`, 40000, "inkomst-lon", "Arbetsgivaren", "salary"]);
  await db.batch(
    rows.map(([id, date, amountKr, category, counterparty, incomeType]) =>
      db
        .prepare(
          `INSERT INTO transactions (id, account_id, fingerprint, status, last_seen_at, transaction_date, booking_date, amount_minor, category_id, category_source, is_internal_transfer, counterparty, counterparty_norm, income_type)
           VALUES (?, 'acc_1', ?, 'booked', ?, ?, ?, ?, ?, 'template', 0, ?, upper(?), ?)`,
        )
        .bind(id, id, date, date, date, amountKr * 100, category, counterparty, counterparty, incomeType),
    ),
  );
});
afterAll(async () => {
  await dispose();
});
beforeEach(async () => {
  await db.prepare(`DELETE FROM guideline_one_off_periods`).run();
  await settingsRepository(db).setBudgetPeriodStartDay(1);
});

async function call(method: string, path: string, body?: unknown, env: Partial<Env> = {}, csrf = true) {
  const context: RouteContext = {
    waitUntil: () => undefined,
    sync: { logger: captureLogs().logger, clock: fixedClock("2026-11-15T10:00:00.000Z"), newId: () => "x", providerFor: () => null },
    connectorFor: () => null,
  };
  const headers = new Headers({ "cf-access-jwt-assertion": await signToken(key), "content-type": "application/json" });
  if (method !== "GET" && csrf) {
    headers.set("origin", ORIGIN);
    headers.set("x-kronkoll", "1");
  }
  const init = { method, headers, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) };
  return handle(new Request(`${ORIGIN}${path}`, init), configuredEnv({ DB: db, ...env }), guardDeps, context);
}


const kr = (amount: number) => amount * 100;
const NONE = { one_off_periods: [] };

interface Line {
  category_id: string;
  average_minor: number;
  normal_minor: number;
  fixed_minor: number;
  actual_minor: number;
  last_minor: number;
}
interface Guidelines {
  expected_income_minor: number;
  fixed_minor: number;
  one_off_periods: string[];
  categories: Line[];
}
const get = async (path = "/api/guidelines?period=2026-11"): Promise<Guidelines> => {
  const body: Guidelines = await (await call("GET", path)).json();
  return body;
};
const line = (body: Guidelines, id: string): Line => body.categories.find((c) => c.category_id === id) as Line;

describe("GET /api/guidelines (KK-42)", () => {
  it("visar historiskt snitt och normalnivå, fasta kostnader och förväntad inkomst", async () => {
    const body = await get();
    expect(body).toMatchObject({ expected_income_minor: kr(40000), fixed_minor: kr(9000), one_off_periods: [] });
    // Median respektive snitt av de sex senaste månaderna: shopping-månaden styr inte normalnivån.
    expect(line(body, "fritid")).toMatchObject({ normal_minor: kr(1700), average_minor: kr(3850), fixed_minor: 0 });
    expect(line(body, "mat")).toMatchObject({ normal_minor: kr(6150) });
    // Förra periodens utfall (oktober) per huvudkategori, med underkategorierna summerade uppåt.
    expect(body.categories.map((c) => [c.category_id, c.last_minor])).toEqual([["boende", kr(9000)], ["fritid", kr(1600)], ["mat", kr(6400)]]);
    expect(line(body, "boende")).toMatchObject({ normal_minor: kr(9000), fixed_minor: kr(9000) });
  });

  it("visar utfallet hittills i perioden", async () => {
    const body = await get();
    expect(line(body, "fritid")).toMatchObject({ actual_minor: kr(3000) });
    expect(line(body, "mat")).toMatchObject({ actual_minor: kr(3000) });
  });

  it("en månad markerad som engångsperiod lämnas utanför normalnivån men inte snittet", async () => {
    await call("PUT", "/api/guidelines", { one_off_periods: ["2026-09"] });
    const body = await get();
    expect(body.one_off_periods).toEqual(["2026-09"]);
    expect(line(body, "fritid")).toMatchObject({ normal_minor: kr(1600), average_minor: kr(3850) });
  });

  it("utan historik och inkomst är allt noll och inget kraschar", async () => {
    expect(await get("/api/guidelines?period=2024-01")).toMatchObject({ expected_income_minor: 0, categories: [] });
  });

  it("period current och ingen period ger den pågående perioden, som appen frågar efter", async () => {
    for (const path of ["/api/guidelines", "/api/guidelines?period=current", "/api/guidelines?period=current&account=acc_1"]) {
      const res = await call("GET", path);
      expect(res.status).toBe(200);
      const body: { period: { key: string } } = await res.json();
      expect(body.period.key).toBe("2026-11");
    }
  });

  it("avvisar ogiltig period och ogiltigt kontofilter", async () => {
    expect((await call("GET", "/api/guidelines?period=2026-13")).status).toBe(400);
    expect((await call("GET", "/api/guidelines?account=")).status).toBe(400);
  });
});

describe("PUT /api/guidelines (KK-42-E)", () => {
  const put = (body: unknown, csrf = true) => call("PUT", "/api/guidelines", body, {}, csrf);

  it("ersätter listan och svarar med den sorterad", async () => {
    const res = await put({ one_off_periods: ["2026-09", "2026-08"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ one_off_periods: ["2026-08", "2026-09"] });
    await put(NONE);
    expect(await get()).toMatchObject({ one_off_periods: [] });
  });

  it.each([
    ["saknade engångsperioder", {}],
    ["felaktig period", { one_off_periods: ["2026-9"] }],
    ["period som inte är text", { one_off_periods: [202609] }],
    ["samma period två gånger", { one_off_periods: ["2026-09", "2026-09"] }],
    ["för många perioder", { one_off_periods: Array.from({ length: 25 }, (_, i) => `20${String(10 + i)}-01`) }],
    ["kroppen är inte ett objekt", "[]"],
    ["kroppen är inte JSON", "{"],
  ])("avvisar %s och ändrar ingenting", async (_name, body) => {
    await put({ one_off_periods: ["2026-08"] });
    expect((await put(body)).status).toBe(400);
    expect(await get()).toMatchObject({ one_off_periods: ["2026-08"] });
  });

  it("kräver CSRF-skydd", async () => {
    expect((await put(NONE, false)).status).toBe(403);
  });
});

describe("/api/guidelines: fel i databasen", () => {
  const broken = { prepare: () => { throw new Error("D1 nere"); } } as unknown as D1Database;

  it("svarar 503 utan detaljer när databasen inte går att läsa eller skriva", async () => {
    for (const res of [await call("GET", "/api/guidelines", undefined, { DB: broken }), await call("PUT", "/api/guidelines", NONE, { DB: broken })]) {
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "unavailable" });
    }
  });
});

describe("/api/guidelines: metoder", () => {
  it("godtar bara GET och PUT", async () => {
    const res = await call("DELETE", "/api/guidelines");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, PUT");
  });
});
