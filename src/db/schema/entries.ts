import {
  pgTable,
  uuid,
  text,
  timestamp,
  numeric,
  pgEnum,
  varchar,
  index,
} from "drizzle-orm/pg-core";
import { entryGroups } from "./entry-groups";
import { accounts } from "./accounts";
import { items } from "./items";

// ─── Enum ─────────────────────────────────────────────────────────────────────

export const wastageModeEnum = pgEnum("wastage_mode", ["PERCENT", "GRAM"]);

// ─── entries ──────────────────────────────────────────────────────────────────
// CRITICAL: This table is INSERT-ONLY. No UPDATE or DELETE ever. No is_deleted column.

export const entries = pgTable(
  "entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    group_id: uuid("group_id")
      .references(() => entryGroups.id)
      .notNull(),
    lot_id: varchar("lot_id", { length: 20 }),
    from_account_id: uuid("from_account_id")
      .references(() => accounts.id)
      .notNull(),
    to_account_id: uuid("to_account_id")
      .references(() => accounts.id)
      .notNull(),
    item_id: uuid("item_id")
      .references(() => items.id)
      .notNull(),
    // Core quantity fields — all NUMERIC(20,8) per BACKEND_PLAN §4B
    quantity: numeric("quantity", { precision: 20, scale: 8 }).notNull(),
    purity: numeric("purity", { precision: 20, scale: 8 }),
    pure_quantity: numeric("pure_quantity", { precision: 20, scale: 8 }),
    // Optional piece/quantity count entered on Sale (e.g. "2 rings") — purely
    // informational, does not affect weight/pure/balance math anywhere.
    piece_count: numeric("piece_count", { precision: 20, scale: 3 }),
    // Wastage fields
    wastage_mode: wastageModeEnum("wastage_mode"),
    wastage_value: numeric("wastage_value", { precision: 20, scale: 8 }),
    wastage_quantity: numeric("wastage_quantity", { precision: 20, scale: 8 }),
    // Financial fields — NUMERIC(20,2)
    rate: numeric("rate", { precision: 20, scale: 2 }),
    amount: numeric("amount", { precision: 20, scale: 2 }),
    average_touch: numeric("average_touch", { precision: 20, scale: 8 }),
    remarks: text("remarks"),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("entries_group_id_idx").on(t.group_id),
    index("entries_from_account_id_idx").on(t.from_account_id),
    index("entries_to_account_id_idx").on(t.to_account_id),
    index("entries_item_id_idx").on(t.item_id),
    index("entries_lot_id_idx").on(t.lot_id),
    index("entries_created_at_idx").on(t.created_at),
  ],
);
