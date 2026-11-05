// Ett påhittat API för E2E (KK-13: ingen riktig bankdata). Det håller ett litet tillstånd per test,
// så att ett flöde kan spara något och se resultatet efter omladdning, som mot det riktiga API:t.
import type { BrowserContext, Page, Route } from "@playwright/test";

const NOVEMBER = { key: "2026-11", start: "2026-11-01", end: "2026-11-30" };

const CATEGORIES = [
  { id: "mat", parent_id: null, name: "Mat", kind: "expense", archived: false },
  { id: "mat-livsmedel", parent_id: "mat", name: "Livsmedel", kind: "expense", archived: false },
  { id: "hushall", parent_id: null, name: "Hushåll", kind: "expense", archived: false },
  { id: "hushall-forbrukning", parent_id: "hushall", name: "Förbrukning", kind: "expense", archived: false },
  { id: "boende", parent_id: null, name: "Boende", kind: "expense", archived: false },
];

function transaction(id: string, date: string, amountMinor: number, counterparty: string) {
  return {
    id,
    account_id: "acc_1",
    status: "booked",
    transaction_date: date,
    booking_date: date,
    amount_minor: amountMinor,
    counterparty,
    description: "",
    category_id: null as string | null,
    category_source: "none",
    is_internal_transfer: false,
    split: false,
  };
}

/** Bankens inloggning i testerna. connect.spec.ts fångar adressen och skickar tillbaka till appen. */
export const FAKE_BANK = "https://bank.example.test";

/** Påhittade sparmål i samma form som GET /api/goals: i fas, sent och utan sparttakt. */
const GOALS = [
  {
    id: "g1", name: "Resa till Japan", target_minor: 6000000, target_date: "2027-08-31", source: "manual", account_id: null, account_missing: false,
    saved_minor: 2150000, monthly_rate_minor: 320000, contributions: [],
    forecast: { kind: "eta", remaining_minor: 3850000, months_left: 13, reach_period: "2027-12", on_track: false, months_late: 4, required_monthly_minor: 427778 },
  },
  {
    id: "g2", name: "Buffert", target_minor: 10000000, target_date: "2027-12-31", source: "account", account_id: "acc_2", account_missing: false,
    saved_minor: 7400000, monthly_rate_minor: 300000, contributions: [],
    forecast: { kind: "eta", remaining_minor: 2600000, months_left: 9, reach_period: "2027-08", on_track: true, months_late: 0, required_monthly_minor: 200000 },
  },
  {
    id: "g3", name: "Ny barnvagn", target_minor: 800000, target_date: "2027-03-31", source: "manual", account_id: null, account_missing: false,
    saved_minor: 120000, monthly_rate_minor: 0, contributions: [],
    forecast: { kind: "never", remaining_minor: 680000, required_monthly_minor: 170000 },
  },
];

const OVERVIEW = {
  period: NOVEMBER,
  balance_minor: 4831240,
  income_minor: 4125000,
  expense_minor: 2341800,
  net_minor: 1783200,
  budget_minor: 3200000,
  left_to_spend_minor: 858200,
  left_per_day_minor: 53637,
  days_left: 16,
  over: false,
  last_sync_at: "2026-11-15T05:02:11.000Z",
  connections: [{ id: "c1", bank: "Exempelbanken", status: "active", consent_expires_on: "2027-05-01", consent_days_left: 167 }],
  // Ett konto utan saldo, så att axe och Lighthouse även granskar "Saldo saknas" (KK-38-B).
  accounts: [
    { id: "acc_1", name: "Vardag", bank: "Exempelbanken", balance_minor: 1852790 },
    { id: "acc_2", name: "Sparkonto ••7712", bank: "Exempelbanken", balance_minor: 2978450 },
    { id: "acc_3", name: "Kort ••1190", bank: "Exempelbanken", balance_minor: null },
  ],
  trend: [
    { period: "2026-10", income_minor: 3300000, expense_minor: 2900000, net_minor: 400000 },
    { period: "2026-11", income_minor: 4125000, expense_minor: 2341800, net_minor: 1783200 },
  ],
};

const CONNECTION = {
  id: "c1",
  bank: "Exempelbanken",
  status: "active",
  consent_expires_on: "2027-05-01",
  consent_days_left: 167,
  last_success_at: "2026-11-15T05:02:11.000Z",
  consecutive_failures: 0,
  account_count: 2,
};

const ACCOUNTS = [
  { id: "acc_1", name: "Vardag", nickname: "Vardag", bank_name: "Privatkonto ••1234", bank: "Exempelbanken", type: "checking" },
  { id: "acc_2", name: "Sparkonto ••5678", nickname: null, bank_name: "Sparkonto ••5678", bank: "Exempelbanken", type: "savings" },
];

/** Utfall per huvudkategori och period. November saknar budget tills ett test sparar en. */
const ACTUALS: Record<string, Record<string, number>> = {
  "2026-08": { mat: 590000, boende: 980000 },
  "2026-09": { mat: 610000, boende: 980000 },
  "2026-10": { mat: 620000, boende: 980000 },
  "2026-11": { mat: 655200, boende: 980000 },
};

export interface FakeApi {
  readonly rules: { id: string; pattern: string; category_id: string; source: string; hits: number }[];
  readonly budgetPuts: unknown[];
}

/** Gör alla belopp (fält som slutar på _minor) `scale` gånger större, för att pröva långa belopp i UI:t. */
function scaleAmounts(value: unknown, scale: number): unknown {
  if (Array.isArray(value)) return value.map((v) => scaleAmounts(v, scale));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, k.endsWith("_minor") && typeof v === "number" ? v * scale : scaleAmounts(v, scale)]),
  );
}

/** Svarar på alla /api/*-anrop från sidan, eller från alla flikar i en webbläsare, med påhittad data. */
export async function useFakeApi(
  page: Page | BrowserContext,
  options: { scale?: number; connected?: boolean; consentDaysLeft?: number } = {},
): Promise<FakeApi> {
  const transactions = [
    transaction("t1", "2026-11-12", -41250, "Hörnbutiken Exempelvägen"),
    transaction("t2", "2026-11-05", -18900, "Hörnbutiken Exempelvägen"),
    transaction("t3", "2026-11-03", -129900, "Påhittade Möbler AB"),
  ];
  const budgets = new Map<string, { category_id: string; budget_minor: number }[]>();
  const goals: Record<string, unknown>[] = GOALS.map((g) => ({ ...g }));
  const state: FakeApi = { rules: [], budgetPuts: [] };
  // Utan bank visar översikten välkomstsidan. Kopplingen görs klar med koden som banken skickar tillbaka.
  let connected = options.connected ?? true;
  const overview = () =>
    connected
      ? { ...OVERVIEW, connections: OVERVIEW.connections.map((c) => ({ ...c, consent_days_left: options.consentDaysLeft ?? c.consent_days_left })) }
      : { ...OVERVIEW, connections: [], accounts: [], last_sync_at: null };

  const budget = (key: string) => {
    const lines = budgets.get(key) ?? [];
    const groups = Object.entries(ACTUALS[key] ?? {}).map(([categoryId, actual]) => {
      const planned = lines.find((l) => l.category_id === categoryId)?.budget_minor ?? null;
      return {
        category_id: categoryId,
        actual_minor: actual,
        budget_minor: planned,
        remaining_minor: planned === null ? null : planned - actual,
        percent: planned === null ? null : Math.round((actual / planned) * 100),
        over: planned !== null && actual > planned,
        subcategories: [],
      };
    });
    const total = (pick: (g: (typeof groups)[number]) => number | null) => groups.reduce((sum, g) => sum + (pick(g) ?? 0), 0);
    return {
      period: { key, start: `${key}-01`, end: `${key}-28` },
      lines,
      groups,
      uncategorized_minor: 0,
      total_budget_minor: total((g) => g.budget_minor),
      total_actual_minor: total((g) => g.actual_minor),
      excluded_internal_minor: 0,
    };
  };

  const handle = (method: string, path: string, body: Record<string, unknown>): [number, unknown] => {
    if (path === "/api/overview") return [200, overview()];
    if (path === "/api/goals" && method === "POST") {
      const goal = {
        ...GOALS[2], id: `g${String(goals.length + 1)}`, name: body["name"], target_minor: body["target_minor"], target_date: body["target_date"] ?? null,
        saved_minor: 0, monthly_rate_minor: 0, forecast: { kind: "never", remaining_minor: body["target_minor"], required_monthly_minor: null },
      };
      goals.push(goal);
      return [201, goal];
    }
    if (path === "/api/goals") return [200, { items: goals }];
    const goalPath = /^\/api\/goals\/([^/]+)(\/contributions)?$/u.exec(path);
    const goal = goals.find((g) => g["id"] === goalPath?.[1]);
    if (goal && goalPath?.[2] && method === "POST") {
      const amount = Number(body["amount_minor"]);
      goal["saved_minor"] = Number(goal["saved_minor"]) + amount;
      goal["contributions"] = [{ date: "2026-11-15", amount_minor: amount }, ...(goal["contributions"] as unknown[])];
      return [201, goal];
    }
    if (goal && !goalPath?.[2]) return [200, goal];
    if (path === "/api/categories") return [200, { items: CATEGORIES }];
    if (path === "/api/rules") return [200, { items: state.rules }];
    if (path === "/api/connections" && method === "POST") return [200, { redirect_url: `${FAKE_BANK}/auth?state=s-1` }];
    if (path === "/api/connections/callback" && method === "POST") {
      if (body["code"] !== "c-1" || body["state"] !== "s-1") return [400, { error: "invalid_state" }];
      connected = true;
      return [201, { connection_id: "c1", accounts: 3, initial_sync: "started", renewed: false }];
    }
    if (path === "/api/connections") return [200, { items: [CONNECTION] }];
    if (path === "/api/accounts") return [200, { items: ACCOUNTS }];
    if (path === "/api/settings") return [200, { budget_period_start_day: 1, current_period: NOVEMBER }];
    if (path === "/api/transactions") return [200, { period: NOVEMBER, items: transactions, next_cursor: null }];
    const tx = /^\/api\/transactions\/([^/]+)$/u.exec(path);
    const found = transactions.find((t) => t.id === tx?.[1]);
    if (found && method === "PATCH") {
      found.category_id = String(body["category_id"]);
      found.category_source = "manual";
      if (body["learn_rule"] !== true) return [200, { transaction: found, rule: null, retroactive_candidates: 0, protected_manual: 0 }];
      const pattern = body["rule_pattern"];
      const rule = { id: "r-1", pattern: typeof pattern === "string" ? pattern : found.counterparty.toUpperCase(), category_id: found.category_id, source: "learned", hits: 1 };
      state.rules.push(rule);
      const candidates = transactions.filter((t) => t.counterparty === found.counterparty && t.category_id === null).length;
      return [200, { transaction: found, rule, retroactive_candidates: candidates, protected_manual: 0 }];
    }
    if (path === "/api/rules/r-1/apply" && method === "POST") {
      const rule = state.rules[0];
      const matching = transactions.filter((t) => t.category_id === null && t.counterparty.toUpperCase().startsWith(rule?.pattern ?? "\u0000"));
      for (const t of matching) Object.assign(t, { category_id: rule?.category_id ?? null, category_source: "rule" });
      if (rule) rule.hits += matching.length;
      return [200, { updated: matching.length, skipped_manual: 0 }];
    }
    const key = /^\/api\/budgets\/(.+)$/u.exec(path)?.[1]?.replace("current", NOVEMBER.key);
    if (key !== undefined && method === "PUT") {
      state.budgetPuts.push(body);
      const lines = Array.isArray(body["lines"]) ? (body["lines"] as { category_id: string; amount_minor: number }[]) : [];
      budgets.set(key, lines.map((l) => ({ category_id: l.category_id, budget_minor: l.amount_minor })));
      return [200, { period: key, lines: lines.length }];
    }
    if (key !== undefined && method === "DELETE") {
      budgets.delete(key);
      return [204, null];
    }
    if (key !== undefined && key in ACTUALS) return [200, budget(key)];
    return [404, { error: "not_found" }];
  };

  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
    const [status, json] = handle(request.method(), new URL(request.url()).pathname, body);
    await route.fulfill(status === 204 ? { status } : { status, json: scaleAmounts(json, options.scale ?? 1) });
  });
  return state;
}
