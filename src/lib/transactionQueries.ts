import { db } from "@/db";
import { entryGroups, entries, accounts, items } from "@/db/schema";
import { eq, and, ilike, count, gte, lte, desc, max, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

// ─── Shared db-or-transaction type ───────────────────────────────────────────
// Both the top-level `db` and a Drizzle PgTransaction expose the same query
// methods. The only difference is that `db` carries a `$client` property that
// transactions do not. Using this union lets helpers accept either.
type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// ─── Bill number generator ────────────────────────────────────────────────────
// Per plan §12.3 Step 5: MAX(bill_no) + 1 per account/type

export async function generateBillNo(
  tx: DbOrTx,
  accountId: string,
  type: string,
): Promise<number> {
  // Lock the account row to serialize bill generation for this account
  await tx.execute(
    sql`SELECT id FROM ${accounts} WHERE id = ${accountId} FOR UPDATE`
  );

  const [row] = await tx
    .select({ max: max(entryGroups.bill_no) })
    .from(entryGroups)
    .where(
      and(
        eq(entryGroups.account_id, accountId),
        eq(entryGroups.type, type as any),
      ),
    );
  return (row?.max ?? 0) + 1;
}

// ─── Shared list query ────────────────────────────────────────────────────────

export interface ListTxInput {
  page: number;
  limit: number;
  search?: string;
  from_date?: string;
  to_date?: string;
  is_converted?: boolean;
}

export async function listTransactions(
  type: string,
  input: ListTxInput,
) {
  const offset = (input.page - 1) * input.limit;

  const conditions = [
    eq(entryGroups.type, type as any),
    eq(entryGroups.is_deleted, false),
  ];
  if (input.from_date)
    conditions.push(gte(entryGroups.date, input.from_date));
  if (input.to_date)
    conditions.push(lte(entryGroups.date, input.to_date));
  
  if (input.is_converted !== undefined) {
    if (input.is_converted) {
      conditions.push(sql`(${entryGroups.gst_amount} IS NOT NULL AND ${entryGroups.gst_amount} != '0')`);
    } else {
      conditions.push(sql`(${entryGroups.gst_amount} IS NULL OR ${entryGroups.gst_amount} = '0')`);
    }
  }

  const where = and(...conditions);

  const [data, [countRow]] = await Promise.all([
    db
      .select({
        group: entryGroups,
        account_name: accounts.name,
      })
      .from(entryGroups)
      .leftJoin(accounts, eq(entryGroups.account_id, accounts.id))
      .where(where)
      .orderBy(desc(entryGroups.created_at))
      .limit(input.limit)
      .offset(offset),
    db.select({ total: count() }).from(entryGroups).where(where),
  ]);

  return { data, total: countRow?.total ?? 0 };
}

// ─── Get transaction by id (group + entries) ──────────────────────────────────

export async function getTransactionById(id: string) {
  const [group] = await db
    .select({
      group: entryGroups,
      account_name: accounts.name,
    })
    .from(entryGroups)
    .leftJoin(accounts, eq(entryGroups.account_id, accounts.id))
    .where(and(eq(entryGroups.id, id), eq(entryGroups.is_deleted, false)))
    .limit(1);

  if (!group) return null;

  const txEntries = await db
    .select({
      entry: entries,
      item_name: items.name,
      item_type: items.type,
    })
    .from(entries)
    .leftJoin(items, eq(entries.item_id, items.id))
    .where(eq(entries.group_id, id));

  return { ...group, entries: txEntries };
}
