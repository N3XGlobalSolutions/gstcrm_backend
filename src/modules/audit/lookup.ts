import { sql } from "drizzle-orm";
import { db } from "@/db";
import {
  describeRecord,
  isLookupTable,
  isUuid,
  LOOKUP_TABLES,
  parseRowData as parseData,
  RECORD_LABEL_MAX,
  type LookupTable,
  type RowData,
} from "./recordLabel";

// ─── Live-row lookups for record labels ───────────────────────────────────────
// Reads current rows as to_jsonb(row) — the same shape the audit trigger stores —
// so describeRecord() labels them exactly like audit rows. Table names come only
// from the LOOKUP_TABLES whitelist; ids are checked to be uuids before querying.

/** Current rows of one lookup table by id (unknown / non-uuid ids are skipped). */
export async function fetchRowsById(table: LookupTable, ids: readonly string[]): Promise<Map<string, RowData>> {
  const out = new Map<string, RowData>();
  const wanted = [...new Set(ids.filter(isUuid))];
  if (!isLookupTable(table) || wanted.length === 0) return out;
  const rows = await db.execute<{ id: string; data: string }>(sql`
    select t.id::text as id, to_jsonb(t)::text as data
      from ${sql.identifier(table)} t
     where t.id in (${sql.join(
       wanted.map((id) => sql`${id}::uuid`),
       sql`, `,
     )})
  `);
  for (const row of rows) {
    const data = parseData(row.data);
    if (data) out.set(String(row.id), data);
  }
  return out;
}

/** Labels for many { table, id } pairs (one query per table). Key: `${table}:${id}`. */
export async function labelRecords(
  refs: ReadonlyArray<{ table: string; id: string }>,
): Promise<Map<string, string>> {
  const idsByTable = new Map<LookupTable, string[]>();
  for (const ref of refs) {
    if (!isLookupTable(ref.table) || !isUuid(ref.id)) continue;
    const list = idsByTable.get(ref.table) ?? [];
    list.push(ref.id);
    idsByTable.set(ref.table, list);
  }
  const out = new Map<string, string>();
  await Promise.all(
    [...idsByTable].map(async ([table, ids]) => {
      const rows = await fetchRowsById(table, ids);
      for (const [id, data] of rows) {
        const label = describeRecord(table, data)?.label;
        if (label) out.set(`${table}:${id}`, label);
      }
    }),
  );
  return out;
}

/**
 * Plain-English label of whatever bill / voucher / master row has this uuid
 * ("Purchase · Bill No 3", "Customer · Ravi Kumar"), or null when no lookup
 * table has it. Soft-deleted rows are still found (an edit's input id is the
 * old, now soft-deleted group — it carries the same bill number).
 */
export async function lookupRecordLabel(id: string): Promise<string | null> {
  if (!isUuid(id)) return null;
  const rows = await db.execute<{ t: string; data: string }>(sql`
    select x.t, x.data from (
      ${sql.join(
        LOOKUP_TABLES.map(
          (table, i) =>
            sql`(select ${table}::text as t, ${i}::int as ord, to_jsonb(r)::text as data
                   from ${sql.identifier(table)} r where r.id = ${id}::uuid limit 1)`,
        ),
        sql` union all `,
      )}
    ) x order by x.ord limit 1
  `);
  const row = rows[0];
  if (!row) return null;
  const label = describeRecord(String(row.t), parseData(row.data))?.label ?? null;
  return label ? label.slice(0, RECORD_LABEL_MAX) : null;
}
