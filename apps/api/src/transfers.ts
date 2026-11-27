// Interna överföringar (KK-20-C). Omräkningen används både efter varje synk och när användaren
// markerar en transaktion själv, så att en motpost alltid följer med åt rätt håll.
import { categoryRepository, ruleRepository, transactionRepository } from "@kronkoll/adapter-d1";
import { classifyTransfers, savingCategoryChanges, savingCategoryId, savingKindOf } from "@kronkoll/domain";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

/**
 * Räknar om vilka transaktioner som är interna överföringar och skriver bara det som ändras.
 * Användarens eget val vinner alltid, och regler med åtgärden Räkna inte (KK-39-C) tas med. Hur
 * transaktionen rör en buffert (KK-55) sparas samtidigt. Hela
 * historiken räknas om, eftersom en ny transaktion kan ge en
 * gammal sin motpost. Ingen lista med kortfaktura-mottagare än: korten hör till vanliga konton.
 * Returnerar hur många som ändrades.
 */
export async function recomputeTransfers(db: D1Database): Promise<number> {
  const store = transactionRepository(db);
  const current = await store.forTransfers();
  const now = new Map(current.map((t) => [t.id, t]));
  const classified = classifyTransfers({ transactions: current, accounts: await store.ownAccounts(), cardPaymentCounterparties: [], excludeRules: await ruleRepository(db).excludeRules() }).map(
    (c) => ({ id: c.id, internal: c.internal, pairId: c.pairId, savingKind: savingKindOf(c.reason) }),
  );
  const changes = classified
    .filter((c) => {
      const before = now.get(c.id);
      return before?.internal !== c.internal || before.pairId !== c.pairId || before.savingKind !== c.savingKind;
    });
  await store.setTransfers(changes);
  // Sparande till en buffert får kategorin Sparande när det saknar kategori (KK-53). Ett eget val eller en regel vinner.
  const sparande = savingCategoryId(await categoryRepository(db).list());
  await store.setCategories(savingCategoryChanges(classified.map((c) => ({ ...c, categorySource: now.get(c.id)?.categorySource ?? "none" })), sparande));
  return changes.length;
}

/** Valet ur begäran: true, false eller null (automatiskt). Undefined om formen är fel. */
async function readChoice(request: Request): Promise<boolean | null | undefined> {
  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== "object" || body === null || !("internal" in body)) return undefined;
  const { internal } = body;
  return internal === true || internal === false || internal === null ? internal : undefined;
}

/** PUT /api/transactions/{id}/transfer: "räkna inte som utgift", "räkna som utgift" eller automatiskt. */
export async function putTransfer(request: Request, env: { DB: D1Database }, id: string): Promise<Response> {
  const choice = await readChoice(request);
  if (choice === undefined) return json({ error: "invalid_request" }, 400);
  try {
    const store = transactionRepository(env.DB);
    if (!(await store.setManualTransfer(id, choice))) return json({ error: "not_found" }, 404);
    await recomputeTransfers(env.DB);
    const internal = (await store.forTransfers()).find((t) => t.id === id)?.internal ?? false;
    return json({ transaction_id: id, internal, manual: choice !== null }, 200);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}
