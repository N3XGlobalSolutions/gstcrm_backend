import {
  pgTable,
  uuid,
  integer,
  text,
  numeric,
  timestamp,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { accounts } from "./accounts";

// ─── job_work_cycles ──────────────────────────────────────────────────────────
// Each row represents a permanent, never-ending "bill book" for one account.
// All job-work entry_groups that belong to this cycle carry a `job_work_cycle_id`
// foreign key pointing here.
//
// This mirrors labour_bill_cycles but is kept as a SEPARATE table so job-work
// bill numbers are isolated from labour-bill bill numbers for the same account.

export const jobWorkCycles = pgTable(
  "job_work_cycles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The account this cycle belongs to
    account_id: uuid("account_id")
      .references(() => accounts.id)
      .notNull(),
    // Per-account sequential bill number (1, 2, 3 …)
    bill_no: integer("bill_no").notNull(),
    // Overall purpose / theme of this cycle (user-entered on creation)
    main_reason: text("main_reason"),
    // Required Touch % (0027, owner 2026-11-06): the touch the employee's finished
    // work must come back in — like labour_bill_cycles.required_touch. Optional on
    // the cycle; a job work with any Gold / Ornament Receipt row needs it (from the
    // bill form or stored here). NULL on cycles made before 0027.
    required_touch: numeric("required_touch", { precision: 6, scale: 2 }),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("job_work_cycles_account_id_idx").on(t.account_id),
    // Each bill_no must be unique per account
    unique("job_work_cycles_account_bill_no_unique").on(t.account_id, t.bill_no),
  ],
);
