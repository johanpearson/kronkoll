// Ett påhittat API för E2E (KK-13: ingen riktig bankdata). Det håller ett litet tillstånd per test,
// så att ett flöde kan spara något och se resultatet efter omladdning, som mot det riktiga API:t.
import type { BrowserContext, Page, Route } from "@playwright/test";

const NOVEMBER = { key: "2026-11", start: "2026-11-01", end: "2026-11-30" };

const CATEGORIES = [
  { id: "mat", parent_id: null, name: "Mat", kind: "expense", archived: false },
  { id: "mat-livsmedel", parent_id: "mat", name: "Livsmedel", kind: "expense", archived: false },
  { id: "mat-restaurang", parent_id: "mat", name: "Restaurang", kind: "expense", archived: false },
  { id: "mat-systembolaget", parent_id: "mat", name: "Systembolaget", kind: "expense", archived: false },
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

const OVERVIEW = {
  period: NOVEMBER,
  balance_minor: 4831240,
  // Ett preliminärt köp på Vardag på 412,50 kr (KK-56-F).
  balances: { booked_minor: 4831240, available_minor: 4789990, pending_minor: -41250 },
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
    { id: "acc_1", name: "Vardag", bank: "Exempelbanken", balance_minor: 1852790, booked_minor: 1852790, available_minor: 1811540 },
    { id: "acc_2", name: "Sparkonto ••7712", bank: "Exempelbanken", balance_minor: 2978450, booked_minor: 2978450, available_minor: 2978450 },
    { id: "acc_3", name: "Kort ••1190", bank: "Exempelbanken", balance_minor: null, booked_minor: null, available_minor: null },
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
  { id: "acc_1", name: "Vardag", nickname: "Vardag", bank_name: "Privatkonto ••1234", bank: "Exempelbanken", type: "checking", role: "spending" },
  { id: "acc_2", name: "Sparkonto ••5678", nickname: null, bank_name: "Sparkonto ••5678", bank: "Exempelbanken", type: "savings", role: "spending" },
];

/** Utfall per huvudkategori och period. November saknar budget tills ett test sparar en. */
const ACTUALS: Record<string, Record<string, number>> = {
  "2026-08": { mat: 590000, boende: 980000 },
  "2026-09": { mat: 610000, boende: 980000 },
  "2026-10": { mat: 620000, boende: 980000 },
  "2026-11": { mat: 655200, boende: 980000 },
};

export interface FakeApi {
  readonly rules: { id: string; pattern: string; category_id: string; source: string; hits: number; match?: string }[];
  readonly categoryResets: unknown[];
  readonly budgetPuts: unknown[];
  /** Sparade riktlinjer (KK-42), i den ordning de sparades. */
  readonly guidelinePuts: unknown[];
  /** Ändringar av kontots roll (KK-53-A), i den ordning de sparades. */
  readonly accountPatches: unknown[];
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
  /** Dolda transaktioner (KK-49). */
  const hiddenIds = new Set<string>();
  const salary = {
    id: "lon1", account: { id: "acc_1", name: "Vardag", type: "checking" }, status: "booked", transaction_date: "2026-11-25", booking_date: "2026-11-25",
    amount_minor: 3361000, counterparty: "", counterparty_norm: "EXEMPELFÖRETAGET AB", description: "EXEMPELFÖRETAGET AB LÖN", category_id: null, category_source: "none",
    is_internal_transfer: false, manual_transfer: null, income_type: "other", income_source: "template", transfer_pair: null, splits: [],
    // Varför fick den här kategorin? (KK-58-D). Ingen kategori, och ingen regel träffar.
    category_reason: { source: "none", rule: null, also_matched: [] },
    // Det kända konto överföringen är kopplad till (KK-54-B). Ingen från början.
    known_account: null as { id: string; name: string; source: string } | null,
  };
  /** Kända konton (KK-54), sparade av PUT /api/known-accounts/{id} under testet. */
  const knownAccounts: { id: string; name: string; match_patterns: string[]; category_id: string }[] = [];
  /** Ett påhittat bolån vars bindningstid slutar om 41 dagar (KK-36-C). */
  const loans: Record<string, unknown>[] = [{
    id: "lan1", name: "Bolån del 1", lender: "Exempelbanken", balance_minor: 120000000, interest_rate_bp: 350, rate_fixed_until: "2026-12-15", amortization_minor: 200000,
    monthly_interest_minor: 350000, monthly_amortization_minor: 200000, monthly_cost_minor: 550000, rate_fixed: true, rate_fixed_days_left: 41, rate_fixed_ending: true,
    // Påhittat kontonummer och Betalt denna period (KK-59).
    match_patterns: ["9020-12 345 67"], category_id: "boende-laneranta", paid: { paid_minor: 550000, last_paid_on: "2026-11-02", missing: false },
  }];
  const state: FakeApi = { rules: [], budgetPuts: [], guidelinePuts: [], accountPatches: [], categoryResets: [] };
  let categoriesCleared = false;
  // En kopia per test, eftersom en flytt ändrar platserna (#251). Utan plats ordnas syskonen på namn.
  const categories = CATEGORIES.map((c) => ({ ...c, position: null as number | null }));
  /** Påhittat underlag till budgetplaneraren (KK-42): fasta siffror. */
  const guidelines = () => ({
    period: NOVEMBER,
    one_off_periods: [],
    expected_income_minor: 4000000,
    fixed_minor: 900000,
    categories: [
      { category_id: "boende", average_minor: 980000, normal_minor: 980000, fixed_minor: 900000, actual_minor: 980000, last_minor: 980000 },
      { category_id: "mat", average_minor: 606667, normal_minor: 610000, fixed_minor: 0, actual_minor: 655200, last_minor: 620000 },
    ],
  });
  const accounts = ACCOUNTS.map((a) => ({ ...a }));
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

  const handle = (method: string, path: string, body: Record<string, unknown>, query = new URLSearchParams()): [number, unknown] => {
    if (path === "/api/overview") return [200, overview()];
    if (path === "/api/loans") {
      return [200, {
        loans,
        total_balance_minor: loans.reduce((s, l) => s + Number(l["balance_minor"]), 0),
        total_monthly_interest_minor: loans.reduce((s, l) => s + Number(l["monthly_interest_minor"]), 0),
        total_monthly_amortization_minor: loans.reduce((s, l) => s + Number(l["amortization_minor"]), 0),
        total_monthly_cost_minor: loans.reduce((s, l) => s + Number(l["monthly_cost_minor"]), 0),
      }];
    }
    // Kontouppgifter på lånet (KK-59): förhandsvisningen träffar inget i det påhittade API:t.
    if (path === "/api/loans/preview" && method === "POST") return [200, { count: 0, examples: [] }];
    const matchingId = /^\/api\/loans\/([^/]+)\/matching$/u.exec(path)?.[1];
    const matchingLoan = loans.find((l) => l["id"] === matchingId);
    if (matchingLoan && method === "PUT") {
      matchingLoan["match_patterns"] = body["match_patterns"];
      matchingLoan["category_id"] = body["category_id"] === undefined ? "boende-laneranta" : body["category_id"];
      return [200, { match_patterns: matchingLoan["match_patterns"], category_id: matchingLoan["category_id"], linked: 0 }];
    }
    const loanId = /^\/api\/loans\/([^/]+)$/u.exec(path)?.[1];
    if (loanId && method === "DELETE") {
      const i = loans.findIndex((l) => l["id"] === loanId);
      if (i < 0) return [404, { error: "not_found" }];
      loans.splice(i, 1);
      return [204, null];
    }
    if (loanId && method === "PUT") {
      const interest = Math.round((Number(body["balance_minor"]) * Number(body["interest_rate_bp"])) / 120000);
      const loan = {
        id: loanId, ...body, monthly_interest_minor: interest, monthly_amortization_minor: body["amortization_minor"],
        monthly_cost_minor: interest + Number(body["amortization_minor"]), rate_fixed: body["rate_fixed_until"] !== null, rate_fixed_days_left: body["rate_fixed_until"] === null ? null : 500, rate_fixed_ending: false,
        match_patterns: [], category_id: null, paid: { paid_minor: 0, last_paid_on: null, missing: false },
      };
      const i = loans.findIndex((l) => l["id"] === loanId);
      if (i >= 0) loans[i] = loan;
      else loans.push(loan);
      return [i >= 0 ? 200 : 201, loan];
    }
    if (path === "/api/insights") {
      return [200, {
        period: { key: "2026-11", start: "2026-11-01", end: "2026-11-30" },
        history_periods: ["2026-10", "2026-09", "2026-08"],
        anomalies: [{ category_id: "mat-livsmedel", actual_minor: 375000, baseline_minor: 257000, diff_minor: 118000, pct: 46 }],
        recurring: [
          { name: "Streamingtjänst", interval: "monthly", amount_minor: 14900, last_date: "2026-10-19", next_expected: "2026-11-19", yearly_minor: 178800, occurrences: 4 },
          { name: "Hemförsäkring AB", interval: "yearly", amount_minor: 234000, last_date: "2026-02-03", next_expected: "2027-02-03", yearly_minor: 234000, occurrences: 2 },
        ],
        recurring_yearly_minor: 412800,
        top_expenses: [{ id: "t1", date: "2026-11-01", name: "Möbelhuset Påhittat", amount_minor: 890000, category_id: "hushall-forbrukning", split: false }],
        top_categories: [{ category_id: "hushall", amount_minor: 890000 }, { category_id: "mat", amount_minor: 523000 }],
      }];
    }
    if (path === "/api/income/2026-10") {
      return [200, { period: "2026-10", items: [
        { id: "lon1", date: "2026-10-26", amount_minor: 3361000, counterparty: "Påhittade Bygg AB", description: "", income_type: "salary", income_source: "learned" },
        { id: "swish1", date: "2026-10-12", amount_minor: 42000, counterparty: "", description: "Swish från Anna", income_type: null, income_source: "none" },
      ] }];
    }
    if (path === "/api/income") {
      return [200, { months: [
        { period: "2026-09", salary_minor: 1120000, parental_benefit_minor: 995000, other_minor: 78000 },
        { period: "2026-10", salary_minor: 3361000, parental_benefit_minor: 0, other_minor: 42000 },
        { period: "2026-11", salary_minor: 3361000, parental_benefit_minor: 483000, other_minor: 281000 },
      ] }];
    }
    if (path === "/api/categories") return [200, { items: categoriesCleared ? [] : categories }];
    const move = /^\/api\/categories\/([^/]+)\/move$/u.exec(path);
    if (move && method === "POST") {
      const moving = categories.find((c) => c.id === move[1]);
      if (!moving) return [404, { error: "not_found" }];
      const place = (c: { position: number | null }) => c.position ?? Number.POSITIVE_INFINITY;
      const siblings = categories
        .filter((c) => c.parent_id === moving.parent_id && c.kind === moving.kind && c.id !== moving.id)
        .sort((a, b) => (place(a) === place(b) ? a.name.localeCompare(b.name, "sv") : place(a) - place(b)));
      const at = siblings.findIndex((c) => c.id === body["before_id"]);
      siblings.splice(at < 0 ? siblings.length : at, 0, moving);
      siblings.forEach((c, i) => { c.position = i; });
      return [200, { items: siblings.map((c) => ({ ...c })) }];
    }
    const ruleMatches = /^\/api\/rules\/([^/]+)\/matches$/u.exec(path);
    if (ruleMatches && method === "GET") {
      const rule = state.rules.find((r) => r.id === ruleMatches[1]);
      if (!rule) return [404, { error: "not_found" }];
      // De senaste träffarna (#251): fyra transaktioner, av vilka tre listas.
      return [
        200,
        {
          total: 4,
          change: 2,
          unchanged: 1,
          manual: 1,
          items: [
            { id: "m1", transaction_date: "2026-11-02", name: `${rule.pattern} KARLSTAD`, amount_minor: -49900, category_id: null, effect: "change" },
            { id: "m2", transaction_date: "2026-10-20", name: "", amount_minor: -12000, category_id: rule.category_id, effect: "unchanged" },
            { id: "m3", transaction_date: "2026-10-01", name: `${rule.pattern} JARFALLA`, amount_minor: -30000, category_id: "fritid", effect: "manual" },
          ],
        },
      ];
    }
    if (path === "/api/rules" && method === "POST" && body["preview"] === true) {
      // Träffarna för regeln som den skulle bli (#251), utan att spara den. Fyra transaktioner, varav en är manuellt vald.
      const name = String(body["pattern"]).trim().toUpperCase();
      return [
        200,
        {
          applied: 3,
          protected_manual: 1,
          overridden_manual: body["override_manual"] === true ? 1 : 0,
          matches: {
            total: 4,
            change: 2,
            unchanged: 1,
            manual: 1,
            items: [
              { id: "p1", transaction_date: "2026-11-02", name: `${name} KARLSTAD`, amount_minor: -49900, category_id: null, effect: "change" },
              { id: "p2", transaction_date: "2026-10-20", name: `${name} STOCKHOLM`, amount_minor: -12000, category_id: "hushall-forbrukning", effect: "unchanged" },
              { id: "p3", transaction_date: "2026-10-01", name: `${name} JARFALLA`, amount_minor: -30000, category_id: "fritid", effect: "manual" },
            ],
          },
        },
      ];
    }
    if (path === "/api/rules" && method === "POST") {
      const text = String(body["pattern"]).trim().toUpperCase();
      const rule = { id: `r-${String(state.rules.length + 1)}`, match: body["match"] === "contains" ? "description_contains" : "counterparty_prefix", pattern: text, category_id: String(body["category_id"]), source: "learned", hits: 0 };
      state.rules.push(rule);
      return [201, { rule, applied: 0, retroactive_candidates: 0, protected_manual: 0 }];
    }
    // Platsen i användarens ordning (KK-58-C): den senast skapade står först, som i det riktiga API:t.
    if (path === "/api/rules") return [200, { items: state.rules.map((r, i) => ({ ...r, position: r.source === "learned" ? -i : null })) }];
    if (path === "/api/rules/order" && method === "PUT") {
      const order = Array.isArray(body["order"]) ? (body["order"] as string[]) : [];
      state.rules.sort((a, b) => order.indexOf(b.id) - order.indexOf(a.id));
      return [200, { updated: 0 }];
    }
    if (path === "/api/categories/reset" && method === "POST") {
      if (body["preview"] === true) return [200, { categories: 37, rules: 14, transactions: 812, splits: 3, budget_lines: 9 }];
      state.categoryResets.push(body);
      categoriesCleared = true;
      return [200, { reset: true }];
    }
    if (path === "/api/connections" && method === "POST") return [200, { redirect_url: `${FAKE_BANK}/auth?state=s-1` }];
    if (path === "/api/connections/callback" && method === "POST") {
      if (body["code"] !== "c-1" || body["state"] !== "s-1") return [400, { error: "invalid_state" }];
      connected = true;
      return [201, { connection_id: "c1", accounts: 3, initial_sync: "started", renewed: false }];
    }
    if (path === "/api/connections") return [200, { items: [CONNECTION] }];
    // Sidan om en koppling (#259): påhittade konton och en kort synklogg.
    if (path === "/api/connections/c1" && method === "GET") {
      return [
        200,
        {
          ...CONNECTION,
          accounts: ACCOUNTS.map((a) => ({ id: a.id, name: a.name, balance_minor: 1852790 })),
          history: { accounts: 2, transactions: 120, splits: 1 },
          sync_runs: [{ kind: "cron", status: "ok", started_at: "2026-11-15T05:02:11.000Z", new_count: 3, updated_count: 1, error_code: null }],
        },
      ];
    }
    if (path === "/api/accounts") return [200, { items: accounts }];
    const accountPath = /^\/api\/accounts\/([^/]+)$/u.exec(path);
    const account = accounts.find((a) => a.id === accountPath?.[1]);
    if (account && method === "PATCH") {
      state.accountPatches.push(body);
      const role = body["role"];
      if (typeof role === "string") account.role = role;
      return [200, { id: account.id, name: account.name, nickname: account.nickname, role: account.role }];
    }
    if (path === "/api/settings") return [200, { budget_period_start_day: 1, current_period: NOVEMBER }];
    // Web Push är påslaget på servern (KK-27). I E2E är service workers avstängda, så vyn säger att enheten saknar stöd.
    if (path === "/api/push") return [200, { configured: true, public_key: "BPublicKeyForE2E", topics: ["consent", "budget_over", "sync_failed"] }];
    if (path === "/api/transactions/hide" && method === "POST") {
      const ids = Array.isArray(body["ids"]) ? (body["ids"] as string[]) : [];
      for (const id of ids) hiddenIds[body["hidden"] === true ? "add" : "delete"](id);
      return [200, { updated: ids.length, hidden: body["hidden"] === true }];
    }
    if (path === "/api/transactions") {
      const wantHidden = query.get("hidden") === "true";
      const status = query.get("status");
      const items = transactions.filter((t) => hiddenIds.has(t.id) === wantHidden && (status === null || t.status === status));
      return [200, { period: NOVEMBER, items: items.map((t) => ({ ...t, hidden: hiddenIds.has(t.id) })), next_cursor: null }];
    }
    // Gruppen Preliminärt (KK-56-A): alla preliminära som inte är dolda, med summa.
    if (path === "/api/transactions/pending") {
      const items = transactions.filter((t) => t.status === "pending" && !hiddenIds.has(t.id));
      return [200, { items: items.map((t) => ({ ...t, hidden: false })), total_minor: items.reduce((sum, t) => sum + t.amount_minor, 0), count: items.length }];
    }
    // Kända konton (KK-54): lista, förhandsvisning, spara och ta bort.
    if (path === "/api/known-accounts" && method === "GET") return [200, { known_accounts: knownAccounts }];
    if (path === "/api/known-accounts/preview" && method === "POST") {
      // Två påhittade överföringar innehåller "swish"; allt annat träffar inget.
      const patterns = Array.isArray(body["match_patterns"]) ? (body["match_patterns"] as string[]) : [];
      return [200, { count: patterns.some((p) => p.toLowerCase().includes("swish")) ? 2 : 0 }];
    }
    const knownId = /^\/api\/known-accounts\/([^/]+)$/u.exec(path)?.[1];
    if (knownId && method === "PUT") {
      const account = { id: knownId, name: String(body["name"]), match_patterns: body["match_patterns"] as string[], category_id: String(body["category_id"]) };
      const i = knownAccounts.findIndex((a) => a.id === knownId);
      if (i >= 0) knownAccounts[i] = account;
      else knownAccounts.push(account);
      return [i >= 0 ? 200 : 201, { ...account, linked: 2 }];
    }
    if (knownId && method === "DELETE") {
      const i = knownAccounts.findIndex((a) => a.id === knownId);
      if (i < 0) return [404, { error: "not_found" }];
      knownAccounts.splice(i, 1);
      return [204, null];
    }
    // Koppla en överföring till ett känt konto för hand (KK-54-C).
    const txKnown = /^\/api\/transactions\/([^/]+)\/known-account$/u.exec(path)?.[1];
    if (txKnown && method === "PUT") {
      const account = knownAccounts.find((a) => a.id === body["known_account_id"]);
      salary.known_account = account ? { id: account.id, name: account.name, source: "manual" } : null;
      return [200, { known_account: salary.known_account, category_id: account?.category_id ?? null, category_source: account ? "learned" : "none" }];
    }
    // Koppla en betalning till ett lån för hand (KK-59-B).
    const txLoan = /^\/api\/transactions\/([^/]+)\/loan$/u.exec(path)?.[1];
    if (txLoan && method === "PUT") {
      const loan = loans.find((l) => l["id"] === body["loan_id"]);
      return [200, { loan: loan ? { id: loan["id"], name: loan["name"], source: "manual" } : null, category_id: null, category_source: "none" }];
    }
    const tx = /^\/api\/transactions\/([^/]+)$/u.exec(path);
    // En påhittad löneinbetalning som bara nås via sin adress, för inkomsttypen på detaljsidan (KK-22-A).
    if (tx?.[1] === "lon1" && method === "PATCH") {
      salary.income_type = String(body["income_type"]);
      salary.income_source = "manual";
      return [200, { transaction: { id: "lon1", income_type: salary.income_type, income_source: "manual" }, rule: null, updated: 2 }];
    }
    if (tx?.[1] === "lon1") return [200, salary];
    const found = transactions.find((t) => t.id === tx?.[1]);
    if (found && method === "PATCH") {
      found.category_id = String(body["category_id"]);
      found.category_source = "manual";
      if (body["learn_rule"] !== true) return [200, { transaction: found, rule: null, applied: 0, retroactive_candidates: 0, protected_manual: 0 }];
      const pattern = body["rule_pattern"];
      const rule = { id: "r-1", pattern: typeof pattern === "string" ? pattern : found.counterparty.toUpperCase(), category_id: found.category_id, source: "learned", hits: 1 };
      state.rules.push(rule);
      // Som det riktiga API:t tillämpas regeln direkt på tidigare köp hos samma motpart (KK-58-A).
      const earlier = transactions.filter((t) => t.counterparty === found.counterparty && t.category_id === null);
      for (const t of earlier) Object.assign(t, { category_id: found.category_id, category_source: "rule" });
      rule.hits += earlier.length;
      return [200, { transaction: found, rule, applied: earlier.length, retroactive_candidates: 0, protected_manual: 0 }];
    }
    if (path === "/api/rules/r-1/apply" && method === "POST") {
      const rule = state.rules[0];
      const matching = transactions.filter((t) => t.category_id === null && t.counterparty.toUpperCase().startsWith(rule?.pattern ?? "\u0000"));
      for (const t of matching) Object.assign(t, { category_id: rule?.category_id ?? null, category_source: "rule" });
      if (rule) rule.hits += matching.length;
      return [200, { updated: matching.length, skipped_manual: 0 }];
    }
    if (path === "/api/guidelines" && method === "GET") return [200, guidelines()];
    if (path === "/api/guidelines" && method === "PUT") {
      state.guidelinePuts.push(body);
      return [200, { one_off_periods: body["one_off_periods"] }];
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
    const [status, json] = handle(request.method(), new URL(request.url()).pathname, body, new URL(request.url()).searchParams);
    await route.fulfill(status === 204 ? { status } : { status, json: scaleAmounts(json, options.scale ?? 1) });
  });
  return state;
}
