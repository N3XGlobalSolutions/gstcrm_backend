import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, asc, count, desc, eq, gte, ilike, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { router, protectedProcedure, superadminProcedure } from "@/lib/trpc";
import { db } from "@/db";
import { dataAuditLog } from "@/db/schema";
import { writeAuditLog } from "@/modules/logs/audit";
import { istDateRange, likePattern, LOG_DATE_REGEX } from "@/modules/logs/helpers";
import { AUDITED_TABLES, isAuditedTable } from "./labels";
import { verifyChain } from "./verify";
import { labelRecords } from "./lookup";
import { parseRowData } from "./recordLabel";
import { dominantParent, groupSaves, type SaveRow, type SaveSourceRow } from "./saves";

export type { SaveRow, SaveAction, SaveRecord } from "./saves";

// ─── dataAudit router ("Bill & Data History") ─────────────────────────────────
// Rows are written by the gstcrm_audit_row() trigger (migration 0025). bigint
// columns (id, tx_id) are returned as strings so they survive JSON.

export type DataAuditOperation = "INSERT" | "UPDATE" | "DELETE";

export interface DataAuditRow {
  id: string;
  tx_id: string;
  table_name: string;
  record_id: string | null;
  parent_table: string | null;
  parent_id: string | null;
  operation: DataAuditOperation;
  old_data: Record<string, unknown> | null;
  new_data: Record<string, unknown> | null;
  changed_fields: string[] | null;
  actor_username: string;
  ip: string | null;
  request_path: string | null;
  reason: string | null;
  created_at: Date;
  sealed: boolean;
}

export interface DataAuditEvent {
  tx_id: string;
  created_at: Date;
  actor_username: string;
  ip: string | null;
  reason: string | null;
  request_path: string | null;
  changes: DataAuditRow[];
}

const rowFields = {
  id: sql<string>`${dataAuditLog.id}::text`,
  tx_id: sql<string>`${dataAuditLog.tx_id}::text`,
  table_name: dataAuditLog.table_name,
  record_id: dataAuditLog.record_id,
  parent_table: dataAuditLog.parent_table,
  parent_id: dataAuditLog.parent_id,
  operation: dataAuditLog.operation,
  old_data: dataAuditLog.old_data,
  new_data: dataAuditLog.new_data,
  changed_fields: dataAuditLog.changed_fields,
  actor_username: dataAuditLog.actor_username,
  ip: dataAuditLog.ip,
  request_path: dataAuditLog.request_path,
  reason: dataAuditLog.reason,
  created_at: dataAuditLog.created_at,
  sealed: sql<boolean>`(${dataAuditLog.row_hash} is not null)`,
};

interface SelectedRow {
  id: string;
  tx_id: string;
  table_name: string;
  record_id: string | null;
  parent_table: string | null;
  parent_id: string | null;
  operation: string;
  old_data: unknown;
  new_data: unknown;
  changed_fields: string[] | null;
  actor_username: string;
  ip: string | null;
  request_path: string | null;
  reason: string | null;
  created_at: Date | string;
  sealed: boolean;
}

function toRow(r: SelectedRow): DataAuditRow {
  return {
    id: String(r.id),
    tx_id: String(r.tx_id),
    table_name: r.table_name,
    record_id: r.record_id,
    parent_table: r.parent_table,
    parent_id: r.parent_id,
    operation: r.operation as DataAuditOperation,
    old_data: (r.old_data as Record<string, unknown> | null) ?? null,
    new_data: (r.new_data as Record<string, unknown> | null) ?? null,
    changed_fields: r.changed_fields ?? null,
    actor_username: r.actor_username,
    ip: r.ip,
    request_path: r.request_path,
    reason: r.reason,
    created_at: r.created_at instanceof Date ? r.created_at : new Date(r.created_at as unknown as string),
    sealed: r.sealed === true,
  };
}

const logDate = z.string().regex(LOG_DATE_REGEX, "Date must be YYYY-MM-DD");
const auditedTable = z.string().max(63).refine(isAuditedTable, "Unknown table");

/** Bill / entry / voucher number keys looked up inside new_data / old_data by search. */
const NUMBER_KEYS = ["bill_no", "entry_no", "voucher_no"] as const;
/** Text keys inside the row copies matched (ILIKE) by search. */
const TEXT_KEYS = ["supplier_bill_no", "name"] as const;

function searchCondition(search: string): SQL | undefined {
  const pattern = likePattern(search);
  const conds: (SQL | undefined)[] = [
    ilike(dataAuditLog.record_id, pattern),
    ilike(dataAuditLog.parent_id, pattern),
    ilike(dataAuditLog.reason, pattern),
  ];
  for (const key of TEXT_KEYS) {
    conds.push(sql`(${dataAuditLog.new_data} ->> ${key}) ilike ${pattern}`);
    conds.push(sql`(${dataAuditLog.old_data} ->> ${key}) ilike ${pattern}`);
  }
  // "OV-12", "SB/GST/12", "#12" → 12
  const number = /^\d+$/.test(search.trim()) ? search.trim() : /(\d+)\s*$/.exec(search)?.[1];
  if (number) {
    const n = String(Number(number)); // drop leading zeros
    for (const key of NUMBER_KEYS) {
      conds.push(sql`(${dataAuditLog.new_data} ->> ${key}) = ${n}`);
      conds.push(sql`(${dataAuditLog.old_data} ->> ${key}) = ${n}`);
    }
  }
  return or(...conds);
}

/**
 * An edited bill (sales / purchase / labour bill / job work / expense …) is saved
 * as reverse-the-old + create-a-new entry_groups row in ONE transaction, so its
 * history lives under earlier ids too. Follow that chain backwards: the save that
 * INSERTed this group also soft-deleted (is_deleted false → true) an older group
 * of the same type and bill number — that older group is a previous version.
 */
async function entryGroupLineage(id: string): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    with recursive lineage(id, depth) as (
      select ${id}::text, 0
      union
      select u.record_id, l.depth + 1
        from lineage l
        join data_audit_log i
          on i.table_name = 'entry_groups' and i.record_id = l.id and i.operation = 'INSERT'
        join data_audit_log u
          on u.tx_id = i.tx_id
         and u.table_name = 'entry_groups'
         and u.operation = 'UPDATE'
         and u.record_id <> l.id
         and (u.old_data ->> 'is_deleted') = 'false'
         and (u.new_data ->> 'is_deleted') = 'true'
         and (u.new_data ->> 'type') = (i.new_data ->> 'type')
         and (u.new_data ->> 'bill_no') is not distinct from (i.new_data ->> 'bill_no')
       where l.depth < 50
    )
    select distinct id from lineage where id is not null
  `);
  const ids = rows.map((r) => String(r.id));
  return ids.includes(id) ? ids : [id, ...ids];
}

const HISTORY_LIMIT = 5000;

const listFilters = z.object({
  table: auditedTable.optional(),
  operation: z.enum(["INSERT", "UPDATE", "DELETE"]).optional(),
  userId: z.string().uuid().optional(),
  from: logDate.optional(),
  to: logDate.optional(),
  search: z.string().trim().max(200).optional(),
});

/** WHERE for dataAudit.list / listSaves (row-level: a save matches if any of its rows does). */
function listWhere(input: z.infer<typeof listFilters>): SQL | undefined {
  if (input.from && input.to && input.from > input.to) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "From date must be on or before To date" });
  }
  const conds: (SQL | undefined)[] = [];
  if (input.table) conds.push(eq(dataAuditLog.table_name, input.table));
  if (input.operation) conds.push(eq(dataAuditLog.operation, input.operation));
  if (input.userId) conds.push(eq(dataAuditLog.actor_user_id, input.userId));
  const { start, endExclusive } = istDateRange(input.from, input.to);
  if (start) conds.push(gte(dataAuditLog.created_at, start));
  if (endExclusive) conds.push(lt(dataAuditLog.created_at, endExclusive));
  if (input.search) conds.push(searchCondition(input.search));
  return and(...conds);
}

const txIdText = sql<string>`${dataAuditLog.tx_id}::text`;

/**
 * Row copies are only read for header / GST rows (labels, soft-delete check);
 * bill item & payment lines are by far the most rows, so their copies are skipped.
 */
const lightData = (column: typeof dataAuditLog.old_data | typeof dataAuditLog.new_data) =>
  sql<string | null>`case when ${dataAuditLog.table_name} = 'entries' then null else ${column}::text end`;

const saveRowFields = {
  tx_id: txIdText,
  table_name: dataAuditLog.table_name,
  record_id: dataAuditLog.record_id,
  parent_table: dataAuditLog.parent_table,
  parent_id: dataAuditLog.parent_id,
  operation: dataAuditLog.operation,
  old_data: lightData(dataAuditLog.old_data),
  new_data: lightData(dataAuditLog.new_data),
  actor_username: dataAuditLog.actor_username,
  ip: dataAuditLog.ip,
  request_path: dataAuditLog.request_path,
  reason: dataAuditLog.reason,
  created_at: dataAuditLog.created_at,
};

export const dataAuditRouter = router({
  /** Audited business tables with plain-English labels (for filters / headings). */
  tables: protectedProcedure.query(() => AUDITED_TABLES.map((t) => ({ table: t.table, label: t.label }))),

  /** Settings › Logs › Bill & Data History — newest first. */
  list: superadminProcedure
    .input(
      listFilters.extend({
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(10).max(500).default(50),
      }),
    )
    .query(async ({ input }) => {
      const where = listWhere(input);

      const [rows, [countRow]] = await Promise.all([
        db
          .select(rowFields)
          .from(dataAuditLog)
          .where(where)
          .orderBy(desc(dataAuditLog.created_at), desc(dataAuditLog.id))
          .limit(input.pageSize)
          .offset((input.page - 1) * input.pageSize),
        db.select({ total: count() }).from(dataAuditLog).where(where),
      ]);

      return { rows: rows.map(toRow), total: Number(countRow?.total ?? 0) };
    }),

  /**
   * Settings › Logs › Bill & Data History — one row per save (tx_id), newest
   * first. Filters / search match a save when ANY of its rows matches (same
   * conditions as list); change_count / tables / action / record cover all of
   * the save's rows.
   */
  listSaves: superadminProcedure
    .input(
      listFilters.extend({
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(10).max(100).default(50),
      }),
    )
    .query(async ({ input }): Promise<{ rows: SaveRow[]; total: number }> => {
      const where = listWhere(input);

      // 1. This page's saves (tx ids) and the total number of matching saves.
      const [page, [countRow]] = await Promise.all([
        db
          .select({ tx_id: txIdText })
          .from(dataAuditLog)
          .where(where)
          .groupBy(dataAuditLog.tx_id)
          .orderBy(sql`max(${dataAuditLog.created_at}) desc`, desc(dataAuditLog.tx_id))
          .limit(input.pageSize)
          .offset((input.page - 1) * input.pageSize),
        db
          .select({ total: sql<string>`count(distinct ${dataAuditLog.tx_id})` })
          .from(dataAuditLog)
          .where(where),
      ]);
      const total = Number(countRow?.total ?? 0);
      const txIds = page.map((p) => String(p.tx_id));
      if (txIds.length === 0) return { rows: [], total };

      // 2. Every row of only those saves.
      const raw = await db
        .select(saveRowFields)
        .from(dataAuditLog)
        .where(sql`${dataAuditLog.tx_id} in (${sql.join(txIds.map((id) => sql`${id}::bigint`), sql`, `)})`)
        .orderBy(asc(dataAuditLog.id));
      const rows: SaveSourceRow[] = raw.map((r) => ({
        ...r,
        tx_id: String(r.tx_id),
        old_data: parseRowData(r.old_data),
        new_data: parseRowData(r.new_data),
        created_at: r.created_at instanceof Date ? r.created_at : new Date(r.created_at as unknown as string),
      }));
      const saves = groupSaves(rows, txIds);

      // 3. Saves that only touched child rows (e.g. payment lines added to a
      //    bill): label them by their parent bill / voucher as it is now.
      const rowsByTx = new Map<string, SaveSourceRow[]>();
      for (const r of rows) {
        const list = rowsByTx.get(r.tx_id);
        if (list) list.push(r);
        else rowsByTx.set(r.tx_id, [r]);
      }
      const unlabeled = saves
        .filter((s) => !s.record)
        .map((s) => ({ save: s, parent: dominantParent(rowsByTx.get(s.tx_id) ?? []) }))
        .filter((u): u is { save: SaveRow; parent: { table: string; id: string } } => !!u.parent);
      if (unlabeled.length > 0) {
        try {
          const labels = await labelRecords(unlabeled.map((u) => u.parent));
          for (const { save, parent } of unlabeled) {
            const label = labels.get(`${parent.table}:${parent.id}`);
            if (label) save.record = { table: parent.table, id: parent.id, label };
          }
        } catch (err) {
          console.error("[audit] Could not label saves by parent:", err);
        }
      }

      return { rows: saves, total };
    }),

  /** Every row of one save (tx_id), in the order they were written. */
  saveDetail: superadminProcedure
    .input(z.object({ txId: z.string().trim().regex(/^\d{1,19}$/, "Invalid save id") }))
    .query(async ({ input }): Promise<{ changes: DataAuditRow[] }> => {
      const rows = await db
        .select(rowFields)
        .from(dataAuditLog)
        .where(sql`${dataAuditLog.tx_id} = ${input.txId}::bigint`)
        .orderBy(asc(dataAuditLog.id))
        .limit(HISTORY_LIMIT);
      return { changes: rows.map(toRow) };
    }),

  /**
   * Every save that touched one bill / voucher / master row, oldest first: rows
   * whose parent is it, or that are it. For entry_groups, earlier versions of an
   * edited bill are included (see entryGroupLineage).
   */
  recordHistory: protectedProcedure
    .input(z.object({ table: auditedTable, id: z.string().trim().min(1).max(100) }))
    .query(async ({ input }) => {
      const ids = input.table === "entry_groups" ? await entryGroupLineage(input.id) : [input.id];

      const rows = await db
        .select(rowFields)
        .from(dataAuditLog)
        .where(
          or(
            and(eq(dataAuditLog.parent_table, input.table), inArray(dataAuditLog.parent_id, ids)),
            and(eq(dataAuditLog.table_name, input.table), inArray(dataAuditLog.record_id, ids)),
          ),
        )
        .orderBy(asc(dataAuditLog.created_at), asc(dataAuditLog.id))
        .limit(HISTORY_LIMIT);

      const events: DataAuditEvent[] = [];
      const byTx = new Map<string, DataAuditEvent>();
      for (const raw of rows) {
        const row = toRow(raw);
        let event = byTx.get(row.tx_id);
        if (!event) {
          event = {
            tx_id: row.tx_id,
            created_at: row.created_at,
            actor_username: row.actor_username,
            ip: row.ip,
            reason: row.reason,
            request_path: row.request_path,
            changes: [],
          };
          byTx.set(row.tx_id, event);
          events.push(event);
        }
        event.changes.push(row);
      }
      return { events };
    }),

  /** Recompute the hash chain ("data" = bill history, "security" = audit log). */
  verify: superadminProcedure
    .input(z.object({ chain: z.enum(["data", "security"]) }))
    .mutation(async ({ input, ctx }) => {
      const result = await verifyChain(input.chain);
      try {
        await writeAuditLog({
          actor: { id: ctx.user.id, username: ctx.user.username },
          action: "audit_chain_verified",
          targetType: "audit_chain",
          targetId: input.chain,
          targetLabel: `${input.chain === "data" ? "Bill & data history" : "Audit log"}: ${result.ok ? "intact" : "BROKEN"} — ${result.message}`,
          ip: ctx.ip ?? null,
          userAgent: ctx.userAgent ?? null,
        });
      } catch (err) {
        console.error("[audit] Could not record audit_chain_verified:", err);
      }
      return result;
    }),
});
