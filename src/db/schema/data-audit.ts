import {
  pgTable,
  bigserial,
  bigint,
  varchar,
  text,
  jsonb,
  uuid,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ─── data_audit_log ("Bill & Data History") ───────────────────────────────────
// One row per INSERT / UPDATE / DELETE of a business row, written by the
// gstcrm_audit_row() Postgres trigger (migration 0025 — not by app code).
// UPDATEs where nothing but updated_at changed are skipped.
//  - tx_id groups every row change of one save (txid_current()).
//  - parent_table / parent_id: the bill / voucher / master the row belongs to
//    (child rows such as entries point at their entry_groups row; header rows
//    point at themselves).
//  - actor_*: from the transaction-local gstcrm.* settings (src/db/index.ts).
//    actor_user_id has NO foreign key — the history must survive user deletion.
//  - seal_seq / prev_hash / row_hash: HMAC hash chain written by the sealer job
//    (src/modules/audit/sealer.ts). Chain order is seal_seq, not id.
// Tamper protection: BEFORE UPDATE / DELETE / TRUNCATE triggers refuse every
// change except sealing an unsealed row and retention deletes (8-year floor).

export const dataAuditLog = pgTable(
  "data_audit_log",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    tx_id: bigint("tx_id", { mode: "bigint" }).notNull(),
    table_name: varchar("table_name", { length: 63 }).notNull(),
    record_id: text("record_id"),
    parent_table: varchar("parent_table", { length: 63 }),
    parent_id: text("parent_id"),
    operation: varchar("operation", { length: 6 }).notNull(), // 'INSERT' | 'UPDATE' | 'DELETE'
    old_data: jsonb("old_data").$type<Record<string, unknown>>(),
    new_data: jsonb("new_data").$type<Record<string, unknown>>(),
    changed_fields: text("changed_fields").array(),
    actor_user_id: uuid("actor_user_id"),
    actor_username: varchar("actor_username", { length: 100 }).default("unknown").notNull(),
    ip: varchar("ip", { length: 45 }),
    request_path: varchar("request_path", { length: 150 }),
    reason: text("reason"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    seal_seq: bigint("seal_seq", { mode: "bigint" }).unique(),
    prev_hash: varchar("prev_hash", { length: 64 }),
    row_hash: varchar("row_hash", { length: 64 }),
  },
  (t) => [
    index("data_audit_log_parent_idx").on(t.parent_table, t.parent_id),
    index("data_audit_log_record_idx").on(t.table_name, t.record_id),
    index("data_audit_log_created_at_idx").on(t.created_at),
    index("data_audit_log_tx_id_idx").on(t.tx_id),
    index("data_audit_log_actor_idx").on(t.actor_user_id),
    // The sealer picks unsealed rows in id order — keeps that cheap as the table grows.
    index("data_audit_log_unsealed_idx").on(t.id).where(sql`${t.seal_seq} IS NULL`),
  ],
);
