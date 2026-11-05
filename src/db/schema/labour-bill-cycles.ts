import {
  pgTable,
  uuid,
  integer,
  text,
  numeric,
  timestamp,
  index,
  unique,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { accounts } from "./accounts";

// ─── labour_bill_cycles ───────────────────────────────────────────────────────
// Each row represents a permanent, never-ending "bill book" for one goldsmith.
// All labour-bill entry_groups that belong to this cycle carry a `bill_cycle_id`
// foreign key pointing here.

export const labourBillCycles = pgTable(
  "labour_bill_cycles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The goldsmith (account) this cycle belongs to
    account_id: uuid("account_id")
      .references(() => accounts.id)
      .notNull(),
    // Per-account sequential bill number (1, 2, 3 …)
    bill_no: integer("bill_no").notNull(),
    // Overall purpose / theme of this cycle (user-entered on creation)
    main_reason: text("main_reason"),
    // Customer cycle (0026): the touch the customer wants the finished ornaments
    // in — asked once, when the cycle is created. NULL on cycles made before 0026.
    required_touch: numeric("required_touch", { precision: 6, scale: 2 }),
    // OPEN = takes new labour bills / job-work links; DELIVERED = closed (bills
    // already on it can still be edited). Reopen sets it back to OPEN.
    status: text("status", { enum: ["OPEN", "DELIVERED"] }).default("OPEN").notNull(),
    delivered_at: timestamp("delivered_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("labour_bill_cycles_account_id_idx").on(t.account_id),
    // Each bill_no must be unique per goldsmith
    unique("labour_bill_cycles_account_bill_no_unique").on(t.account_id, t.bill_no),
    check("labour_bill_cycles_status_check", sql`${t.status} in ('OPEN', 'DELIVERED')`),
  ],
);
