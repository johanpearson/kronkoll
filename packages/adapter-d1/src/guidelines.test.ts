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
  await db.batch([db.prepare(`DELETE FROM guideline_overrides`), db.prepare(`DELETE FROM guideline_one_off_periods`), db.prepare(`DELETE FROM guideline_settings`)]);
});

const count = async (table: string): Promise<number> => (await db.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? -1;

describe("guidelineRepository (KK-42)", () => {
  it("utan sparade val är läget ingen budget, sparmålet noll och listorna tomma", async () => {
    expect(await guidelineRepository(db).get()).toEqual({ mode: "none", savingGoalMinor: 0, overrides: [], oneOffPeriods: [] });
  });

  it("sparar och läser läge, sparmål, manuella nivåer och engångsperioder i fast ordning", async () => {
    const repo = guidelineRepository(db);
    await repo.save({
      mode: "saving",
      savingGoalMinor: 800_000,
      overrides: [
        { categoryId: "mat-livsmedel", amountMinor: 560_000 },
        { categoryId: "boende-hyra-avgift", amountMinor: 0 },
      ],
      oneOffPeriods: ["2026-09", "2026-08"],
    });
    expect(await repo.get()).toEqual({
      mode: "saving",
      savingGoalMinor: 800_000,
      overrides: [
        { categoryId: "boende-hyra-avgift", amountMinor: 0 },
        { categoryId: "mat-livsmedel", amountMinor: 560_000 },
      ],
      oneOffPeriods: ["2026-08", "2026-09"],
    });
  });

  it("en ny sparning ersätter den förra, och läget gäller tills det ändras", async () => {
    const repo = guidelineRepository(db);
    await repo.save({ mode: "saving", savingGoalMinor: 1, overrides: [{ categoryId: "mat-livsmedel", amountMinor: 5 }], oneOffPeriods: ["2026-09"] });
    await repo.save({ mode: "none", savingGoalMinor: 800_000, overrides: [], oneOffPeriods: [] });
    expect(await repo.get()).toEqual({ mode: "none", savingGoalMinor: 800_000, overrides: [], oneOffPeriods: [] });
    expect(await count("guideline_settings")).toBe(1);
  });

  it("ett fel ändrar ingenting: okänd kategori och negativt belopp avvisas", async () => {
    const repo = guidelineRepository(db);
    await repo.save({ mode: "saving", savingGoalMinor: 100, overrides: [], oneOffPeriods: ["2026-09"] });
    await expect(repo.save({ mode: "budget", savingGoalMinor: 5, overrides: [{ categoryId: "finns-inte", amountMinor: 1 }], oneOffPeriods: [] })).rejects.toThrow();
    await expect(repo.save({ mode: "budget", savingGoalMinor: 5, overrides: [{ categoryId: "mat-livsmedel", amountMinor: -1 }], oneOffPeriods: [] })).rejects.toThrow();
    await expect(repo.save({ mode: "budget", savingGoalMinor: -1, overrides: [], oneOffPeriods: [] })).rejects.toThrow();
    await expect(repo.save({ mode: "budget", savingGoalMinor: 5, overrides: [], oneOffPeriods: ["2026-9"] })).rejects.toThrow();
    expect(await repo.get()).toEqual({ mode: "saving", savingGoalMinor: 100, overrides: [], oneOffPeriods: ["2026-09"] });
  });

  it("en manuell nivå försvinner när kategorin tas bort", async () => {
    const repo = guidelineRepository(db);
    await db.prepare(`INSERT INTO categories (id, name, kind) VALUES ('tillfallig', 'Tillfällig', 'expense')`).run();
    await repo.save({ mode: "saving", savingGoalMinor: 0, overrides: [{ categoryId: "tillfallig", amountMinor: 100 }], oneOffPeriods: [] });
    await db.prepare(`DELETE FROM categories WHERE id = 'tillfallig'`).run();
    expect((await repo.get()).overrides).toEqual([]);
  });
});
