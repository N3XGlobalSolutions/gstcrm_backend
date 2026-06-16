import { sql } from "drizzle-orm";
import type { Database } from "@/db";

type DbOrTx = Parameters<Parameters<Database["transaction"]>[0]>[0] | Database;

/**
 * Generate the next entry_no for a table.
 * Must be called inside the caller's DB transaction to prevent race conditions.
 *
 * @param tx - The active Drizzle transaction (or db for one-off reads)
 * @param tableName - Exact table name as stored in PostgreSQL
 * @returns The next entry_no as a number
 */
export async function generateEntryNo(
  tx: DbOrTx,
  tableName: string,
): Promise<number> {
  await (tx as Database).execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('entry_no_' || ${tableName}))`,
  );

  const result = await (tx as Database).execute(
    `SELECT COALESCE(MAX(entry_no), 0) + 1 AS next_entry_no FROM "${tableName}"`,
  );

  const rows = result as unknown as Array<{ next_entry_no: string | null }>;
  return Number(rows[0]?.next_entry_no ?? 1);
}

/**
 * Generate the next entry_no for a specific entry_group type.
 * REVERSAL groups are excluded from all sequences, so each business type
 * (PURCHASE, SALE, etc.) has its own independent numbering.
 * Only counts non-deleted groups so voided entries free up their number.
 * Must be called inside the caller's DB transaction.
 *
 * @param tx - The active Drizzle transaction
 * @param type - The entry_group type (e.g. 'PURCHASE', 'SALE')
 * @returns The next entry_no as a number
 */
export async function generateEntryGroupNo(
  tx: DbOrTx,
  type: string,
): Promise<number> {
  await (tx as Database).execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('entry_group_no_' || ${type}))`,
  );

  const result = await (tx as Database).execute(
    `SELECT COALESCE(MAX(entry_no), 0) + 1 AS next_entry_no FROM entry_groups WHERE type = '${type}'`,
  );

  const rows = result as unknown as Array<{ next_entry_no: string | null }>;
  return Number(rows[0]?.next_entry_no ?? 1);
}

/**
 * Generate the next lot_id for tracking physical pieces.
 * Format: LOT-XXXX (zero-padded 4 digits minimum)
 * Must be called inside the caller's DB transaction.
 *
 * @param tx - The active Drizzle transaction
 * @returns The next lot_id as a string e.g. 'LOT-0001'
 */
export async function generateLotId(tx: DbOrTx): Promise<string> {
  await (tx as Database).execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('lot_id'))`,
  );

  const result = await (tx as Database).execute(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(lot_id FROM 5) AS INTEGER)), 0) + 1 AS next_lot_no FROM "entries" WHERE lot_id IS NOT NULL`,
  );

  const rows = result as unknown as Array<{ next_lot_no: string | number | null }>;
  const nextNo = Number(rows[0]?.next_lot_no ?? 1);
  return `LOT-${String(nextNo).padStart(4, "0")}`;
}
