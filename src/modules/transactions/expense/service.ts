import { db } from "@/db";
import { accounts, entries, entryGroups } from "@/db/schema";
import { AppError } from "@/types/errors";
import { createEntryGroup } from "@/lib/entryBuilder";
import { reverseEntryGroup } from "@/lib/reversal";
import { generateEntryNo } from "@/lib/entryNoGenerator";
import { generateBillNo, getTransactionById } from "@/lib/transactionQueries";
import { toDecimal } from "@/lib/decimal";
import { SYSTEM_ACCOUNTS, SYSTEM_ITEMS } from "@/config/constants";
import { desc, eq, and, ilike, count, sum, sql } from "drizzle-orm";
import type { z } from "zod";
import type {
  ListExpenseSchema,
  GetByIdSchema,
  CreateExpenseSchema,
  UpdateExpenseSchema,
  DeleteExpenseSchema,
} from "./schema";

// ─── Find or create expense account by name ───────────────────────────────────

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Runs inside the caller's save transaction, so a refused save never leaves a
// freshly created expense account behind.
async function findOrCreateExpenseAccount(tx: Tx, name: string): Promise<string> {
  // Try find existing EXPENSE account with this name
  const [existing] = await tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        ilike(accounts.name, name),
        eq(accounts.type, "EXPENSE"),
        eq(accounts.is_deleted, false),
      ),
    )
    .limit(1);

  if (existing) return existing.id;

  // Create a new EXPENSE account
  const entry_no = await generateEntryNo(tx, "accounts", "EXPENSE");
  const [created] = await tx
    .insert(accounts)
    .values({ entry_no, name, type: "EXPENSE" })
    .returning({ id: accounts.id });

  return created!.id;
}

// ─── listExpenses ─────────────────────────────────────────────────────────────

export async function listExpenses(input: z.infer<typeof ListExpenseSchema>) {
  const offset = (input.page - 1) * input.limit;

  const conditions = [
    eq(entryGroups.type, "EXPENSE"),
    eq(entryGroups.is_deleted, false),
  ];

  const where = and(...conditions);

  const [data, [countRow], [summaryRow]] = await Promise.all([
    db
      .select({
        group: entryGroups,
        account_name: accounts.name,
        amount: sql<string>`(SELECT quantity::text FROM ${entries} WHERE group_id = ${entryGroups.id} AND item_id = ${SYSTEM_ITEMS.RUPEE_ITEM_ID} LIMIT 1)`,
        from_account_id: sql<string>`(SELECT from_account_id::text FROM ${entries} WHERE group_id = ${entryGroups.id} AND item_id = ${SYSTEM_ITEMS.RUPEE_ITEM_ID} LIMIT 1)`,
        bank_details: sql<string | null>`(SELECT remarks FROM ${entries} WHERE group_id = ${entryGroups.id} AND item_id = ${SYSTEM_ITEMS.RUPEE_ITEM_ID} LIMIT 1)`
      })
      .from(entryGroups)
      .leftJoin(accounts, eq(entryGroups.account_id, accounts.id))
      .where(where)
      .orderBy(desc(entryGroups.created_at))
      .limit(input.limit)
      .offset(offset),
    db.select({ total: count() }).from(entryGroups).where(where),
    // total_value = SUM of RUPEE entry quantities in EXPENSE groups
    db.execute<{ total_value: string }>(
      sql`SELECT COALESCE(SUM(e.quantity), 0)::text AS total_value
          FROM ${entries} e
          JOIN ${entryGroups} g ON e.group_id = g.id
          WHERE g.type = 'EXPENSE'
            AND g.is_deleted = false
            AND e.item_id = ${SYSTEM_ITEMS.RUPEE_ITEM_ID}`,
    ),
  ]);

  return {
    data,
    total: countRow?.total ?? 0,
    summary: {
      total_bills: countRow?.total ?? 0,
      total_value: summaryRow?.total_value ?? "0",
    },
  };
}

// ─── getExpenseById ───────────────────────────────────────────────────────────

export async function getExpenseById(input: z.infer<typeof GetByIdSchema>) {
  const tx = await getTransactionById(input.id);
  if (!tx) throw new AppError("NOT_FOUND", "Expense not found");
  return tx;
}

// ─── createExpense ────────────────────────────────────────────────────────────

export async function createExpense(
  input: z.infer<typeof CreateExpenseSchema>,
  options?: {
    existingBillNo?: number;
    existingEntryNo?: number;
    /** Edit: the stored version to reverse inside the same save transaction. */
    reverseGroupId?: string;
  }
) {
  if (toDecimal(input.amount).lte(0)) {
    throw new AppError("VALIDATION_ERROR", "Amount must be greater than zero");
  }

  // One transaction: on an edit the old version's reversal and the new version
  // commit or roll back together — a refused save leaves the original intact.
  return db.transaction(async (tx) => {
    if (options?.reverseGroupId) {
      await reverseEntryGroup(options.reverseGroupId, tx);
    }

    const expense_account_id = await findOrCreateExpenseAccount(tx, input.name);

    const bill_no = options?.existingBillNo ?? await generateBillNo(tx, SYSTEM_ACCOUNTS.EXPENSE_ID, "EXPENSE");

    const from_account_id = input.from_account_id || SYSTEM_ACCOUNTS.CASH_ID;

    const { group, entries: created } = await createEntryGroup({
      type: "EXPENSE",
      accountId: expense_account_id,
      date: input.date,
      billNo: bill_no,
      entryNo: options?.existingEntryNo,
      remarks: input.reason,
      entries: [
        {
          fromAccountId: from_account_id,
          toAccountId: expense_account_id,
          itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID,
          quantity: input.amount,
          remarks: input.bank_details || undefined,
        },
      ],
    }, tx);

    return { group, entries: created };
  });
}

// ─── updateExpense ────────────────────────────────────────────────────────────

export async function updateExpense(input: z.infer<typeof UpdateExpenseSchema>) {
  const [originalGroup] = await db
    .select({
      bill_no: entryGroups.bill_no,
      entry_no: entryGroups.entry_no,
      type: entryGroups.type,
      is_deleted: entryGroups.is_deleted,
    })
    .from(entryGroups)
    .where(eq(entryGroups.id, input.id))
    .limit(1);

  // Only a live EXPENSE may be edited here. Any other id (a sale, a melting…)
  // would otherwise be reversed by this edit — silently undoing that record.
  if (!originalGroup || originalGroup.type !== "EXPENSE") {
    throw new AppError("NOT_FOUND", "Expense not found");
  }
  // An old (already edited) version keeps the message the reversal gives.
  if (originalGroup.is_deleted) {
    throw new AppError("CONFLICT", "Transaction already reversed");
  }

  // Reverse + re-create in ONE transaction (reverseGroupId) — see createExpense.
  const { id: _removed, ...createInput } = input;
  return createExpense(createInput, {
    existingBillNo: originalGroup.bill_no ?? undefined,
    existingEntryNo: originalGroup.entry_no ?? undefined,
    reverseGroupId: input.id,
  });
}

// ─── deleteExpense ────────────────────────────────────────────────────────────

export async function deleteExpense(input: z.infer<typeof DeleteExpenseSchema>) {
  throw new AppError("BUSINESS_RULE_VIOLATION", "Delete option has been disabled for expenses");
}
