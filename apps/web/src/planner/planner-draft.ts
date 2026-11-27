// Utkastet till en budgetplan (KK-42-D): inkomstrader, ändrade belopp och sparande, per period i
// webbläsaren. Det sparas bara på enheten och rensas när planen sparas som budget eller förslaget återställs.
// Lagringen kan saknas eller vara blockerad (privat läge), och då fungerar planeraren ändå, utan utkast.

export interface IncomeRow {
  readonly id: string;
  readonly name: string;
  /** Beloppet som användaren skrev, i kronor. */
  readonly text: string;
}

export interface Draft {
  /** Null tills användaren ändrat inkomsten: då gäller den förväntade. */
  readonly incomes: readonly IncomeRow[] | null;
  /** Ändrade belopp per huvudkategori. Övriga följer förslaget. */
  readonly edited: Readonly<Record<string, string>>;
  readonly saving: string;
}

export const EMPTY_DRAFT: Draft = { incomes: null, edited: {}, saving: "" };

const key = (periodKey: string) => `kronkoll.plan.${periodKey}`;

const isString = (value: unknown): value is string => typeof value === "string";

function isIncomeRow(value: unknown): value is IncomeRow {
  return typeof value === "object" && value !== null && isString((value as IncomeRow).id) && isString((value as IncomeRow).name) && isString((value as IncomeRow).text);
}

/** Utkastet för perioden, eller ett tomt om det saknas eller är trasigt. */
export function loadDraft(periodKey: string): Draft {
  try {
    const raw = window.localStorage.getItem(key(periodKey));
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return EMPTY_DRAFT;
    const { incomes, edited, saving } = parsed as Record<string, unknown>;
    const editedOk = typeof edited === "object" && edited !== null && Object.values(edited).every(isString);
    return {
      incomes: Array.isArray(incomes) && incomes.every(isIncomeRow) ? incomes : null,
      edited: editedOk ? (edited as Record<string, string>) : {},
      saving: isString(saving) ? saving : "",
    };
  } catch {
    return EMPTY_DRAFT;
  }
}

export function saveDraft(periodKey: string, draft: Draft): void {
  try {
    window.localStorage.setItem(key(periodKey), JSON.stringify(draft));
  } catch {
    // Utan lagring finns ingen utkast, och planen fungerar ändå.
  }
}

export function clearDraft(periodKey: string): void {
  try {
    window.localStorage.removeItem(key(periodKey));
  } catch {
    // Se saveDraft.
  }
}
