// PUT /api/transactions/{id}/known-account (KK-54-C): kopplar en överföring till ett känt konto för hand, eller tar
// bort kopplingen med `known_account_id: null`. Kopplingen blir manuell och ändras aldrig av kontots matchningstexter.
// Tas den bort sätter reglerna kategorin direkt, så att överföringen inte blir okategoriserad till nästa synk.
// Valfritt kan transaktionens text läggas till som ny matchningstext (`add_pattern: true`).
import { knownAccountRepository, ruleRepository, transactionRepository } from "@kronkoll/adapter-d1";
import { applyRules, normalizeKnownPattern } from "@kronkoll/domain";

const MAX_ID_LENGTH = 64;
const MAX_PATTERN_LENGTH = 60;
const MAX_PATTERNS = 10;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

interface Body {
  readonly knownAccountId: string | null;
  readonly addPattern: boolean;
}

/** Begäran: kontots id eller null, och om texten ska läggas till. Null om formen är fel. */
async function readBody(request: Request): Promise<Body | null> {
  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== "object" || body === null || !("known_account_id" in body)) return null;
  const id: unknown = body.known_account_id;
  const add: unknown = "add_pattern" in body ? body.add_pattern : false;
  if (typeof add !== "boolean") return null;
  if (id === null) return add ? null : { knownAccountId: null, addPattern: false };
  return typeof id === "string" && id !== "" && id.length <= MAX_ID_LENGTH ? { knownAccountId: id, addPattern: add } : null;
}

export async function putTransactionKnownAccount(request: Request, env: { DB: D1Database }, id: string): Promise<Response> {
  const body = await readBody(request);
  if (body === null) return json({ error: "invalid_request" }, 400);
  try {
    const accounts = knownAccountRepository(env.DB);
    const store = transactionRepository(env.DB);
    if (body.addPattern && body.knownAccountId !== null) {
      // Texten som kontot ska känna igen nästa gång: transaktionens meddelande, som användaren själv har valt att spara (KK-54-E).
      const [account, tx] = await Promise.all([accounts.get(body.knownAccountId), store.detail(id)]);
      if (!account || !tx) return json({ error: "not_found" }, 404);
      const text = (tx.description.trim() !== "" ? tx.description : tx.counterparty).trim().slice(0, MAX_PATTERN_LENGTH);
      if (text !== "") {
        const pattern = normalizeKnownPattern(text);
        if (!account.patterns.includes(pattern) && account.patterns.length < MAX_PATTERNS) {
          await accounts.save({ ...account, patterns: [...account.patterns, pattern] });
        }
      }
    }
    if (!(await accounts.setManual(id, body.knownAccountId))) return json({ error: "not_found" }, 404);
    if (body.knownAccountId === null) {
      const tx = await store.get(id);
      if (tx) await store.setCategories(applyRules([tx], await ruleRepository(env.DB).list()));
    }
    const detail = await store.detail(id);
    if (!detail) return json({ error: "not_found" }, 404);
    return json({ known_account: detail.knownAccount, category_id: detail.categoryId, category_source: detail.categorySource }, 200);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}
