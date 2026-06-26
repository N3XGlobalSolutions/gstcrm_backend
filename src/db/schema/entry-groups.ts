import {
  pgTable,
  uuid,
  integer,
  text,
  date,
  timestamp,
  boolean,
  numeric,
  pgEnum,
  index,
} from "drizzle-orm/pg-core";
import { accounts } from "./accounts";
import { labourBillCycles } from "./labour-bill-cycles";

// ─── Enum ─────────────────────────────────────────────────────────────────────

export const entryGroupTypeEnum = pgEnum("entry_group_type", [
  "PURCHASE",
  "SALE",
  "JOB_WORK",
  "LABOUR_BILL",
  "EXPENSE",
  "OPENING",
  "REVERSAL",
]);

// ─── entry_groups ─────────────────────────────────────────────────────────────

export const entryGroups = pgTable(
  "entry_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entry_no: integer("entry_no"),
    bill_no: integer("bill_no"),
    // For LABOUR_BILL entries: links to the permanent bill cycle this entry belongs to
    bill_cycle_id: uuid("bill_cycle_id").references(() => labourBillCycles.id),
    date: date("date").notNull(),
    type: entryGroupTypeEnum("type").notNull(),
    account_id: uuid("account_id")
      .references(() => accounts.id)
      .notNull(),
    rate_per_gram: numeric("rate_per_gram", { precision: 20, scale: 2 }),
    remarks: text("remarks"),
    // Self-referential reversal links
    reversed_by: uuid("reversed_by"),
    reversal_of: uuid("reversal_of"),
    tds_amount: numeric("tds_amount", { precision: 20, scale: 2 }).default("0"),
    tcs_amount: numeric("tcs_amount", { precision: 20, scale: 2 }).default("0"),
    gst_amount: numeric("gst_amount", { precision: 20, scale: 2 }).default("0"),
    is_deleted: boolean("is_deleted").default(false).notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("entry_groups_account_id_idx").on(t.account_id),
    index("entry_groups_type_created_at_idx").on(t.type, t.created_at),
    index("entry_groups_is_deleted_idx").on(t.is_deleted),
    index("entry_groups_created_at_idx").on(t.created_at),
  ],
);
