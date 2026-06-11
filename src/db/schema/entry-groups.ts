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
} from "drizzle-orm/pg-core";
import { accounts } from "./accounts";

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

export const entryGroups = pgTable("entry_groups", {
  id: uuid("id").primaryKey().defaultRandom(),
  entry_no: integer("entry_no"),
  bill_no: integer("bill_no"),
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
});
