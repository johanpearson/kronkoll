/**
 * Sparmål i D1 (KK-21, #39). Prognosen räknas i domänen (`forecastGoal`). Här finns bara det den
 * behöver: målet, dess avsättningar, eller saldot och rörelserna på det kopplade kontot.
 */
import type { D1Database } from "@cloudflare/workers-types";
import type { GoalMovement } from "@kronkoll/domain";
import { and, asc, desc, eq, gte, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { accounts, goalContributions, savingsGoals, transactions } from "./schema.ts";

export interface NewGoal {
  readonly name: string;
  readonly targetMinor: number;
  readonly targetDate: string | null;
  readonly source: "manual" | "account";
  /** Kopplat konto, eller null för manuella avsättningar. */
  readonly accountId: string | null;
  readonly initialMinor: number;
}

export interface GoalRecord extends NewGoal {
  readonly id: string;
}

const columns = {
  id: savingsGoals.id,
  name: savingsGoals.name,
  targetMinor: savingsGoals.targetMinor,
  targetDate: savingsGoals.targetDate,
  source: savingsGoals.source,
  accountId: savingsGoals.accountId,
  initialMinor: savingsGoals.initialMinor,
};

/** Dagen som räknas för en transaktion: bokföringsdag, annars köpdag. */
const day = sql<string>`coalesce(${transactions.bookingDate}, ${transactions.transactionDate})`;

export function goalRepository(d1: D1Database) {
  const db = drizzle(d1);
  return {
    /** Alla mål i den ordning de skapades. */
    async list(): Promise<GoalRecord[]> {
      return db.select(columns).from(savingsGoals).orderBy(asc(savingsGoals.createdAt), asc(savingsGoals.id)).all();
    },

    async get(id: string): Promise<GoalRecord | null> {
      const [row] = await db.select(columns).from(savingsGoals).where(eq(savingsGoals.id, id)).all();
      return row ?? null;
    },

    async create(goal: NewGoal, id: string): Promise<void> {
      await db.insert(savingsGoals).values({ id, ...goal }).run();
    },

    /** Lägger till en avsättning. Falskt om målet inte finns. */
    async addContribution(goalId: string, contribution: GoalMovement, id: string): Promise<boolean> {
      const result = await d1
        .prepare(`INSERT INTO goal_contributions (id, goal_id, date, amount_minor) SELECT ?, id, ?, ? FROM savings_goals WHERE id = ?`)
        .bind(id, contribution.date, contribution.amountMinor, goalId)
        .run();
      return result.meta.changes > 0;
    },

    /** Målets avsättningar, nyast först. */
    async contributions(goalId: string): Promise<GoalMovement[]> {
      return db
        .select({ date: goalContributions.date, amountMinor: goalContributions.amountMinor })
        .from(goalContributions)
        .where(eq(goalContributions.goalId, goalId))
        .orderBy(desc(goalContributions.date), desc(sql`rowid`))
        .all();
    },

    /**
     * Saldot på ett kopplat konto och dess rörelser från och med `since`, för takten (KK-21).
     * Borttagna transaktioner räknas inte. Null om kontot inte finns.
     */
    async account(accountId: string, since: string): Promise<{ balanceMinor: number | null; movements: GoalMovement[] } | null> {
      const [account] = await db.select({ balanceMinor: accounts.balanceMinor }).from(accounts).where(eq(accounts.id, accountId)).all();
      if (!account) return null;
      const movements = await db
        .select({ date: day, amountMinor: transactions.amountMinor })
        .from(transactions)
        .where(and(eq(transactions.accountId, accountId), ne(transactions.status, "removed"), gte(day, since)))
        .orderBy(desc(day))
        .all();
      return { balanceMinor: account.balanceMinor, movements };
    },
  };
}
