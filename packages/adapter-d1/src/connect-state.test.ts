import type { D1Database } from "@cloudflare/workers-types";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectStateRepository, STATE_TTL_MINUTES } from "./connect-state.ts";
import { deriveKeys, type Keys } from "./crypto.ts";
import { connectionRepository } from "./repositories.ts";
import { migratedDb, randomSecret } from "./test-support.ts";

let db: D1Database;
let dispose: () => Promise<void>;
let keys: Keys;

beforeAll(async () => {
  ({ db, dispose } = await migratedDb());
  keys = await deriveKeys(randomSecret());
});
afterAll(async () => {
  await dispose();
});

const T0 = new Date("2026-11-20T10:00:00.000Z");
const minutes = (m: number, ms = 0) => new Date(T0.getTime() + m * 60_000 + ms);
const USER = "johan@example.se";

beforeEach(async () => {
  await db.prepare(`DELETE FROM bank_connections`).run();
  await connectionRepository(db, keys).create({ id: "c1", provider: "enablebanking", aspspName: "Skandia" });
});

const rowCount = async () => (await db.prepare(`SELECT count(*) AS n FROM connect_states`).first<{ n: number }>())?.n;

describe("engångs-state för bankflödet (KK-29-A, T-S2)", () => {
  it("gäller i 15 minuter från utfärdandet", async () => {
    const { expiresAt } = await connectStateRepository(db, keys).issue({ connectionId: "c1", userId: USER, now: T0 });
    expect(STATE_TTL_MINUTES).toBe(15);
    expect(expiresAt).toBe(minutes(15).toISOString());
  });

  it("kan användas en gång och ger då kopplingen det hör till", async () => {
    const repo = connectStateRepository(db, keys);
    const { state } = await repo.issue({ connectionId: "c1", userId: USER, now: T0 });
    expect(await repo.consume({ state, userId: USER, now: minutes(2) })).toEqual({ connectionId: "c1" });
  });

  it("avvisar ett state som redan använts", async () => {
    const repo = connectStateRepository(db, keys);
    const { state } = await repo.issue({ connectionId: "c1", userId: USER, now: T0 });
    await repo.consume({ state, userId: USER, now: minutes(1) });
    expect(await repo.consume({ state, userId: USER, now: minutes(2) })).toBeNull();
  });

  it("avvisar ett state som är 15 minuter gammalt, men godtar det en millisekund tidigare", async () => {
    const repo = connectStateRepository(db, keys);
    const a = await repo.issue({ connectionId: "c1", userId: USER, now: T0 });
    const b = await repo.issue({ connectionId: "c1", userId: USER, now: T0 });
    expect(await repo.consume({ state: a.state, userId: USER, now: minutes(15) })).toBeNull();
    expect(await repo.consume({ state: b.state, userId: USER, now: minutes(15, -1) })).toEqual({ connectionId: "c1" });
  });

  it("avvisar ett state som tillhör en annan användare, och förbrukar det inte", async () => {
    const repo = connectStateRepository(db, keys);
    const { state } = await repo.issue({ connectionId: "c1", userId: USER, now: T0 });
    expect(await repo.consume({ state, userId: "annan@example.se", now: minutes(1) })).toBeNull();
    expect(await repo.consume({ state, userId: USER, now: minutes(2) })).toEqual({ connectionId: "c1" });
  });

  it.each([
    ["tom sträng", () => ""],
    ["bara skräp", () => "hej"],
    ["utan signatur", (s: string) => s.split(".")[0] ?? ""],
    ["ändrad signatur", (s: string) => `${s.split(".")[0] ?? ""}.${"A".repeat((s.split(".")[1] ?? "").length)}`],
    ["ändrat id", (s: string) => `${"0".repeat(32)}.${s.split(".")[1] ?? ""}`],
    ["extra del", (s: string) => `${s}.x`],
  ])("avvisar ett manipulerat state (%s), och förbrukar inte det riktiga", async (_, tamper) => {
    const repo = connectStateRepository(db, keys);
    const { state } = await repo.issue({ connectionId: "c1", userId: USER, now: T0 });
    expect(await repo.consume({ state: tamper(state), userId: USER, now: minutes(1) })).toBeNull();
    expect(await repo.consume({ state, userId: USER, now: minutes(2) })).toEqual({ connectionId: "c1" });
  });

  it("avvisar ett state signerat med en annan nyckel", async () => {
    const { state } = await connectStateRepository(db, keys).issue({ connectionId: "c1", userId: USER, now: T0 });
    const otherKeys = await deriveKeys(randomSecret());
    expect(await connectStateRepository(db, otherKeys).consume({ state, userId: USER, now: minutes(1) })).toBeNull();
  });

  it("ger olika, svårgissade värden varje gång och sparar inte själva state-strängen", async () => {
    const repo = connectStateRepository(db, keys);
    const a = await repo.issue({ connectionId: "c1", userId: USER, now: T0 });
    const b = await repo.issue({ connectionId: "c1", userId: USER, now: T0 });
    expect(a.state).not.toBe(b.state);
    expect(a.state).toMatch(/^[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/u);
    const stored = JSON.stringify((await db.prepare(`SELECT * FROM connect_states`).all()).results);
    expect(stored).not.toContain(a.state);
    expect(stored).not.toContain(a.state.split(".")[1] ?? "x");
  });

  it("kan bara utfärdas för en koppling som finns", async () => {
    await expect(connectStateRepository(db, keys).issue({ connectionId: "saknas", userId: USER, now: T0 })).rejects.toThrow();
  });

  it("försvinner när kopplingen raderas (KK-11)", async () => {
    const repo = connectStateRepository(db, keys);
    await repo.issue({ connectionId: "c1", userId: USER, now: T0 });
    await connectionRepository(db, keys).delete("c1");
    expect(await rowCount()).toBe(0);
  });

  it("rensar utgångna och använda state, men låter giltiga ligga kvar", async () => {
    const repo = connectStateRepository(db, keys);
    const used = await repo.issue({ connectionId: "c1", userId: USER, now: T0 });
    await repo.consume({ state: used.state, userId: USER, now: minutes(1) });
    await repo.issue({ connectionId: "c1", userId: USER, now: minutes(-30) });
    const valid = await repo.issue({ connectionId: "c1", userId: USER, now: minutes(10) });
    expect(await repo.purge(minutes(20))).toBe(2);
    expect(await rowCount()).toBe(1);
    expect(await repo.consume({ state: valid.state, userId: USER, now: minutes(21) })).toEqual({ connectionId: "c1" });
  });
});
