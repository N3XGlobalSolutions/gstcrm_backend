import { db } from "@/db";
import { accounts, entryGroups } from "@/db/schema";
import { and, eq, ilike, count, sql } from "drizzle-orm";
import type { z } from "zod";
import type { ListAccountsSchema } from "./schema";

type ListInput = z.infer<typeof ListAccountsSchema>;

// ─── findMany ────────────────────────────────────────────────────────────────

export async function findManyAccounts(input: ListInput) {
  const offset = (input.page - 1) * input.limit;

  const conditions = [eq(accounts.is_deleted, false)];
  if (input.type) conditions.push(eq(accounts.type, input.type));
  if (input.customer_type)
    conditions.push(eq(accounts.customer_type, input.customer_type));
  if (input.search) conditions.push(ilike(accounts.name, `%${input.search}%`));

  const where = and(...conditions);

  const [data, [countRow]] = await Promise.all([
    db
      .select()
      .from(accounts)
      .where(where)
      .orderBy(accounts.entry_no)
      .limit(input.limit)
      .offset(offset),
    db.select({ total: count() }).from(accounts).where(where),
  ]);

  return { data, total: countRow?.total ?? 0 };
}

// ─── findById ────────────────────────────────────────────────────────────────

export async function findAccountById(id: string) {
  const [account] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, id), eq(accounts.is_deleted, false)))
    .limit(1);
  return account ?? null;
}

// ─── hasTransactionHistory ───────────────────────────────────────────────────

export async function hasTransactionHistory(id: string) {
  const [row] = await db
    .select({ id: entryGroups.id })
    .from(entryGroups)
    .where(
      and(eq(entryGroups.account_id, id), eq(entryGroups.is_deleted, false)),
    )
    .limit(1);
  return !!row;
}

// ─── insertAccount ───────────────────────────────────────────────────────────

export async function insertAccount(
  tx: typeof db,
  values: typeof accounts.$inferInsert,
) {
  const [account] = await tx.insert(accounts).values(values).returning();
  return account!;
}

// ─── updateAccount ───────────────────────────────────────────────────────────

export async function updateAccount(
  id: string,
  values: Partial<typeof accounts.$inferInsert>,
) {
  const [account] = await db
    .update(accounts)
    .set({ ...values, updated_at: new Date() })
    .where(eq(accounts.id, id))
    .returning();
  return account!;
}

// ─── softDeleteAccount ───────────────────────────────────────────────────────

export async function softDeleteAccount(id: string) {
  await db
    .update(accounts)
    .set({ is_deleted: true, updated_at: new Date() })
    .where(eq(accounts.id, id));
}
