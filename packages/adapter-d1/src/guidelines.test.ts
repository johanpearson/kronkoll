import type { D1Database } from "@cloudflare/workers-types";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { guidelineRepository } from "./guidelines.ts";
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
  await db.prepare(`DELETE FROM guideline_one_off_periods`).run();
});

describe("guidelineRepository (KK-42-E)", () => {
  it("utan sparade val är listan tom", async () => {
    expect(await guidelineRepository(db).get()).toEqual({ oneOffPeriods: [] });
  });

  it("sparar och läser engångsperioder i fast ordning", async () => {
    const repo = guidelineRepository(db);
    await repo.save({ oneOffPeriods: ["2026-09", "2026-08"] });
    expect(await repo.get()).toEqual({ oneOffPeriods: ["2026-08", "2026-09"] });
  });

  it("en ny sparning ersätter den förra", async () => {
    const repo = guidelineRepository(db);
    await repo.save({ oneOffPeriods: ["2026-09"] });
    await repo.save({ oneOffPeriods: [] });
    expect(await repo.get()).toEqual({ oneOffPeriods: [] });
  });

  it("ett fel ändrar ingenting: en felaktig period avvisas", async () => {
    const repo = guidelineRepository(db);
    await repo.save({ oneOffPeriods: ["2026-09"] });
    await expect(repo.save({ oneOffPeriods: ["2026-9"] })).rejects.toThrow();
    expect(await repo.get()).toEqual({ oneOffPeriods: ["2026-09"] });
  });
});
