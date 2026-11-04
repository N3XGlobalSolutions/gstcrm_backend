// ─── "Bill & Data History": one row per save ──────────────────────────────────
// A save (one tRPC mutation = one database transaction = one tx_id) can write
// many data_audit_log rows — an edited bill is "soft-delete the old group +
// reversal group + new group", each with its item / payment lines. These helpers
// fold those rows into one readable line: what was done (action) and to which
// bill / voucher / master (record).
// Pure — no database / env imports.

import { AUDITED_TABLES } from "./labels";
import { describeRecord, type RowData } from "./recordLabel";

export type SaveAction = "created" | "edited" | "deleted" | "converted" | "other";

export interface SaveRecord {
  table: string;
  id: string;
  label: string;
}

export interface SaveRow {
  tx_id: string;
  created_at: Date;
  actor_username: string;
  ip: string | null;
  reason: string | null;
  request_path: string | null;
  action: SaveAction;
  record: SaveRecord | null;
  change_count: number;
  tables: string[];
}

/** The parts of a data_audit_log row these helpers read. */
export interface SaveSourceRow {
  tx_id: string;
  table_name: string;
  record_id: string | null;
  parent_table: string | null;
  parent_id: string | null;
  operation: string;
  old_data: RowData | null;
  new_data: RowData | null;
  actor_username: string;
  ip: string | null;
  request_path: string | null;
  reason: string | null;
  created_at: Date;
}

// ─── Action ───────────────────────────────────────────────────────────────────

function isSoftDelete(row: Pick<SaveSourceRow, "operation" | "old_data" | "new_data">): boolean {
  return row.operation === "UPDATE" && row.old_data?.is_deleted === false && row.new_data?.is_deleted === true;
}

/**
 * From the procedure name (last segment of the tRPC path) when it says;
 * otherwise from what the rows did: all INSERT → created, any DELETE or
 * soft-delete → deleted, else edited. No rows → other.
 */
export function deriveSaveAction(
  requestPath: string | null | undefined,
  rows: ReadonlyArray<Pick<SaveSourceRow, "operation" | "old_data" | "new_data">>,
): SaveAction {
  const proc = (requestPath ?? "").split(/[./]/).filter(Boolean).pop() ?? "";
  if (proc === "create") return "created";
  if (proc === "update") return "edited";
  if (proc === "delete" || proc === "deleteByLot") return "deleted";
  if (/^(updateGST|convert|undo)/.test(proc)) return "converted";

  if (rows.length === 0) return "other";
  if (rows.every((r) => r.operation === "INSERT")) return "created";
  if (rows.some((r) => r.operation === "DELETE" || isSoftDelete(r))) return "deleted";
  return "edited";
}

// ─── Record ───────────────────────────────────────────────────────────────────

/** Header tables (rows that are records on their own), in tie-break priority order. */
const HEADER_PRIORITY: ReadonlyMap<string, number> = new Map(
  AUDITED_TABLES.filter((t) => !t.parent).map((t, i) => [t.table, i]),
);

/** GST conversion rows name their bill (the entry_groups parent). */
const GST_HISTORY_TABLES: ReadonlySet<string> = new Set(["gst_sales_history", "gst_purchase_history"]);

function rowData(row: Pick<SaveSourceRow, "new_data" | "old_data">): RowData | null {
  return row.new_data ?? row.old_data ?? null;
}

function isDeletedState(row: SaveSourceRow): boolean {
  return row.operation === "DELETE" || rowData(row)?.is_deleted === true;
}

/**
 * The main header row of a save: a header-table row (bill, voucher, master …)
 * that names the record (has a number / name), preferring one that is not
 * deleted and is not a REVERSAL group; ties go to the more important table
 * (entry_groups first), then the earliest row. Without a header row, a GST
 * conversion row names its bill. null when nothing sensible.
 */
export function pickSaveRecord(rows: readonly SaveSourceRow[]): SaveRecord | null {
  let best: { record: SaveRecord; score: number; priority: number } | null = null;
  for (const row of rows) {
    const priority = HEADER_PRIORITY.get(row.table_name);
    if (priority === undefined || !row.record_id) continue;
    const data = rowData(row);
    const desc = describeRecord(row.table_name, data);
    if (!desc) continue;
    const isReversal = row.table_name === "entry_groups" && data?.type === "REVERSAL";
    const score = (desc.specific ? 4 : 0) + (isDeletedState(row) ? 0 : 2) + (isReversal ? 0 : 1);
    if (!best || score > best.score || (score === best.score && priority < best.priority)) {
      best = { record: { table: row.table_name, id: row.record_id, label: desc.label }, score, priority };
    }
  }
  if (best) return best.record;

  for (const row of rows) {
    if (!GST_HISTORY_TABLES.has(row.table_name) || !row.parent_id) continue;
    const desc = describeRecord(row.table_name, rowData(row));
    if (desc?.specific) return { table: "entry_groups", id: row.parent_id, label: desc.label };
  }
  return null;
}

/**
 * The parent (bill / voucher) most of a save's rows belong to — used to label a
 * save that only touched child rows (e.g. payment lines added to a bill).
 */
export function dominantParent(rows: readonly SaveSourceRow[]): { table: string; id: string } | null {
  const counts = new Map<string, { table: string; id: string; n: number }>();
  for (const row of rows) {
    if (!row.parent_table || !row.parent_id) continue;
    const key = `${row.parent_table}\u0000${row.parent_id}`;
    const entry = counts.get(key) ?? { table: row.parent_table, id: row.parent_id, n: 0 };
    entry.n += 1;
    counts.set(key, entry);
  }
  let best: { table: string; id: string; n: number } | null = null;
  for (const entry of counts.values()) if (!best || entry.n > best.n) best = entry;
  return best ? { table: best.table, id: best.id } : null;
}

// ─── Grouping ─────────────────────────────────────────────────────────────────

/**
 * Fold audit rows into one SaveRow per tx_id, in `txOrder` order (tx ids not in
 * `rows` are skipped). Who / where / why come from the save's earliest row.
 */
export function groupSaves(rows: readonly SaveSourceRow[], txOrder: readonly string[]): SaveRow[] {
  const byTx = new Map<string, SaveSourceRow[]>();
  for (const row of rows) {
    const list = byTx.get(row.tx_id);
    if (list) list.push(row);
    else byTx.set(row.tx_id, [row]);
  }
  const saves: SaveRow[] = [];
  for (const txId of txOrder) {
    const txRows = byTx.get(txId);
    if (!txRows || txRows.length === 0) continue;
    let first = txRows[0]!;
    for (const r of txRows) if (r.created_at.getTime() < first.created_at.getTime()) first = r;
    const tables: string[] = [];
    for (const r of txRows) if (!tables.includes(r.table_name)) tables.push(r.table_name);
    const requestPath = txRows.find((r) => r.request_path)?.request_path ?? null;
    saves.push({
      tx_id: txId,
      created_at: first.created_at,
      actor_username: first.actor_username,
      ip: first.ip,
      reason: txRows.find((r) => r.reason)?.reason ?? null,
      request_path: requestPath,
      action: deriveSaveAction(requestPath, txRows),
      record: pickSaveRecord(txRows),
      change_count: txRows.length,
      tables,
    });
  }
  return saves;
}
