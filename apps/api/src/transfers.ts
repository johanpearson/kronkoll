// Interna överföringar (KK-20-C). Omräkningen används både efter varje synk och när användaren
// markerar en transaktion själv, så att en motpost alltid följer med åt rätt håll.
import { transactionRepository } from "@kronkoll/adapter-d1";
import { classifyTransfers } from "@kronkoll/domain";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

/**
 * Räknar om vilka transaktioner som är interna överföringar och skriver bara det som ändras.
 * Användarens eget val vinner alltid. Hela historiken räknas om, eftersom en ny transaktion kan ge en
 * gammal sin motpost. Ingen lista med kortfaktura-mottagare än: korten hör till vanliga konton.
 * Returnerar hur många som ändrades.
 */
export async function recomputeTransfers(db: D1Database): Promise<number> {
  const store = transactionRepository(db);
  const current = await store.forTransfers();
  const now = new Map(current.map((t) => [t.id, t]));
  // Regler med åtgärden Räkna inte (KK-39-C) kopplas in när de kan sparas.
  const changes = classifyTransfers({ transactions: current, accounts: await store.ownAccounts(), cardPaymentCounterparties: [], excludeRules: [] })
    .filter((c) => now.get(c.id)?.internal !== c.internal || now.get(c.id)?.pairId !== c.pairId)
    .map((c) => ({ id: c.id, internal: c.internal, pairId: c.pairId }));
  await store.setTransfers(changes);
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
