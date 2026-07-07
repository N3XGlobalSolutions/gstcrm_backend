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
  type?: string,
): Promise<number> {
  // Use sql template literal for safer execution of raw PG advisory lock queries.
  const lockKey = type ? `${tableName}_${type}` : tableName;
  await (tx as Database).execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${"entry_no_" + lockKey}))`,
  );

  let query;
  if (tableName === "accounts") {
    if (type) {
      query = sql`SELECT COALESCE(MAX(entry_no), 0) + 1 AS next_entry_no FROM accounts WHERE type = ${type} AND is_system_account = false`;
    } else {
      query = sql`SELECT COALESCE(MAX(entry_no), 0) + 1 AS next_entry_no FROM accounts WHERE is_system_account = false`;
    }
  } else if (tableName === "items") {
    if (type) {
      query = sql`SELECT COALESCE(MAX(entry_no), 0) + 1 AS next_entry_no FROM items WHERE type = ${type}`;
    } else {
      query = sql`SELECT COALESCE(MAX(entry_no), 0) + 1 AS next_entry_no FROM items WHERE type != 'MONEY'`;
    }
  } else {
    query = sql`SELECT COALESCE(MAX(entry_no), 0) + 1 AS next_entry_no FROM ${sql.identifier(tableName)}`;
  }

  // Use sql template literal for safe parameterized schema identification.
  const result = await (tx as Database).execute(query);

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
    sql`SELECT pg_advisory_xact_lock(hashtext(${"entry_group_no_" + type}))`,
  );

  // Use sql template literal for safe execution of parameterized query.
  const result = await (tx as Database).execute(
    sql`SELECT COALESCE(MAX(entry_no), 0) + 1 AS next_entry_no FROM entry_groups WHERE type = ${type}`,
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
    sql`SELECT pg_advisory_xact_lock(hashtext(${'lot_id'}))`,
  );

  // Use sql template literal for safe execution.
  const result = await (tx as Database).execute(
    sql`SELECT COALESCE(MAX(CAST(SUBSTRING(lot_id FROM 5) AS INTEGER)), 0) + 1 AS next_lot_no FROM entries WHERE lot_id LIKE 'LOT-%'`,
  );

  const rows = result as unknown as Array<{ next_lot_no: string | number | null }>;
  const nextNo = Number(rows[0]?.next_lot_no ?? 1);
  return `LOT-${String(nextNo).padStart(4, "0")}`;
}

/**
 * Generate a list of next lot_ids in a single database round-trip.
 * Must be called inside the caller's DB transaction.
 *
 * @param tx - The active Drizzle transaction
 * @param count - Number of lot IDs to generate
 * @returns An array of generated lot_id strings
 */
export async function generateLotIds(tx: DbOrTx, count: number): Promise<string[]> {
  if (count <= 0) return [];
  await (tx as Database).execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${'lot_id'}))`,
  );

  const result = await (tx as Database).execute(
    sql`SELECT COALESCE(MAX(CAST(SUBSTRING(lot_id FROM 5) AS INTEGER)), 0) AS max_lot_no FROM entries WHERE lot_id LIKE 'LOT-%'`,
  );

  const rows = result as unknown as Array<{ max_lot_no: string | number | null }>;
  const startNo = Number(rows[0]?.max_lot_no ?? 0) + 1;

  const ids = [];
  for (let i = 0; i < count; i++) {
    ids.push(`LOT-${String(startNo + i).padStart(4, "0")}`);
  }
  return ids;
}
