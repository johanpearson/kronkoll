// Dela upp en transaktion (KK-19): GET och PUT /api/transactions/{id}/splits. Delarna måste summera
// exakt till beloppet. Annars 422 med hur mycket som återstår, så att appen kan säga det (KK-19-B).
import { categoryRepository, splitRepository } from "@kronkoll/adapter-d1";
import { validateSplit, type SplitPart } from "@kronkoll/domain";
import type { SyncDeps } from "./sync.ts";

const MAX_PARTS = 10;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

const toJson = (parts: readonly SplitPart[]) => parts.map((p) => ({ category_id: p.categoryId, amount_minor: p.amountMinor }));

/** Delarna ur begäran, eller null om formen är fel. */
async function readParts(request: Request): Promise<SplitPart[] | null> {
  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== "object" || body === null || !("parts" in body) || !Array.isArray(body.parts) || body.parts.length > MAX_PARTS) return null;
  const parts: SplitPart[] = [];
  for (const raw of body.parts as unknown[]) {
    if (typeof raw !== "object" || raw === null || !("category_id" in raw) || !("amount_minor" in raw)) return null;
    const { category_id: categoryId, amount_minor: amountMinor } = raw;
    if (typeof categoryId !== "string" || !Number.isSafeInteger(amountMinor)) return null;
    parts.push({ categoryId, amountMinor: amountMinor as number });
  }
  return parts;
}

export async function getSplits(env: { DB: D1Database }, id: string): Promise<Response> {
  try {
    const repo = splitRepository(env.DB);
    const amountMinor = await repo.amountOf(id);
    if (amountMinor === null) return json({ error: "not_found" }, 404);
    return json({ transaction_id: id, amount_minor: amountMinor, parts: toJson(await repo.get(id)) }, 200);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}

export async function putSplits(request: Request, env: { DB: D1Database }, sync: SyncDeps, id: string): Promise<Response> {
  const parts = await readParts(request);
  if (!parts) return json({ error: "invalid_request" }, 400);
  try {
    const repo = splitRepository(env.DB);
    const amountMinor = await repo.amountOf(id);
    if (amountMinor === null) return json({ error: "not_found" }, 404);
    if (parts.length > 0) {
      const result = validateSplit(amountMinor, parts);
      if (!result.ok) {
        return result.error === "split_sum_mismatch"
          ? json({ error: result.error, expected_minor: result.expectedMinor, actual_minor: result.actualMinor, remaining_minor: result.remainingMinor }, 422)
          : json({ error: result.error }, 400);
      }
      const known = new Set((await categoryRepository(env.DB).list()).filter((c) => !c.archived).map((c) => c.id));
      if (!parts.every((p) => known.has(p.categoryId))) return json({ error: "unknown_category" }, 400);
    }
    await repo.replace(id, parts, sync.newId);
    return json({ transaction_id: id, parts: parts.length }, 200);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}
