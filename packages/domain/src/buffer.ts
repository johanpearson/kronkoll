/**
 * Bufferten (KK-53, KK-55): vad som sätts in och tas ut per budgetperiod, för kortet Buffert på Översikt.
 *
 * - Insatt: sparande från ett Inkomst/Utgift-konto (räknat på det kontot, som en utgift) och insättningar
 *   från ett uteslutet konto (räknat på bufferten).
 * - Uttaget: uttag från sparande, räknat på Inkomst/Utgift-kontot. Det är varken inkomst eller utgift.
 *
 * Preliminära räknas med, som i budgeten (D-pending). Borttagna räknas inte. Beloppen kontrolleras i sumMinor.
 */
import { sumMinor } from "./money.ts";
import type { BudgetPeriod } from "./period.ts";
import type { CategoryChange, CategorySource } from "./categorize.ts";
import type { TransferClassification } from "./transfers.ts";

/** Hur en transaktion rör bufferten. Sparas per transaktion när överföringarna räknas om. */
export type SavingKind = "saving" | "saving_withdrawal" | "saving_deposit";

export interface BufferTransaction {
  /** Svensk kalenderdag som avgör perioden: bokföringsdag, annars köpdag. */
  readonly date: string;
  readonly amountMinor: number;
  readonly status: "pending" | "booked" | "removed";
  readonly savingKind: SavingKind | null;
}

export interface BufferTotals {
  readonly period: string;
  readonly depositedMinor: number;
  readonly withdrawnMinor: number;
  readonly withdrawalCount: number;
}

/** Vad som sparas om bufferten för en klassad överföring, eller null om den inte rör bufferten. */
export function savingKindOf(reason: TransferClassification["reason"]): SavingKind | null {
  return reason === "saving" || reason === "saving_withdrawal" || reason === "saving_deposit" ? reason : null;
}

export function bufferTotals(transactions: readonly BufferTransaction[], period: BudgetPeriod): BufferTotals {
  const deposited: number[] = [];
  const withdrawn: number[] = [];
  for (const tx of transactions) {
    if (tx.savingKind === null || tx.status === "removed" || tx.date < period.start || tx.date > period.end) continue;
    if (tx.savingKind === "saving_withdrawal") withdrawn.push(tx.amountMinor);
    // Sparandet är ett uttag från Inkomst/Utgift-kontot, insättningen från ett uteslutet konto en insättning på bufferten.
    else deposited.push(Math.abs(tx.amountMinor));
  }
  return { period: period.key, depositedMinor: sumMinor(deposited), withdrawnMinor: sumMinor(withdrawn), withdrawalCount: withdrawn.length };
}

/** Bufferten för flera perioder, i samma ordning, för trenden på kortet (KK-55-A). */
export function bufferTrend(transactions: readonly BufferTransaction[], periods: readonly BudgetPeriod[]): BufferTotals[] {
  return periods.map((period) => bufferTotals(transactions, period));
}

/** Huvudkategorin och underkategorin i mallen som sparande till en buffert får (KK-53). */
const SAVING_PARENT = "Sparande & överföringar";
const SAVING_NAME = "Sparande";

interface NamedCategory {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly archived: boolean;
}

/** Underkategorin Sparande under Sparande & överföringar, eller null om den inte finns, är arkiverad eller omdöpt. */
export function savingCategoryId(categories: readonly NamedCategory[]): string | null {
  const parent = categories.find((c) => c.parentId === null && c.name === SAVING_PARENT && !c.archived);
  if (parent === undefined) return null;
  return categories.find((c) => c.parentId === parent.id && c.name === SAVING_NAME && !c.archived)?.id ?? null;
}

/**
 * Sparande från ett Inkomst/Utgift-konto till en buffert får kategorin Sparande (KK-53), men bara när transaktionen
 * saknar kategori. Ett eget val eller en regel vinner alltid, och kategorin går att ändra som vilken annan som helst.
 */
export function savingCategoryChanges(
  transactions: readonly { readonly id: string; readonly savingKind: SavingKind | null; readonly categorySource: CategorySource }[],
  categoryId: string | null,
): CategoryChange[] {
  if (categoryId === null) return [];
  return transactions
    .filter((tx) => tx.savingKind === "saving" && tx.categorySource === "none")
    .map((tx) => ({ id: tx.id, categoryId, categorySource: "template" }));
}
