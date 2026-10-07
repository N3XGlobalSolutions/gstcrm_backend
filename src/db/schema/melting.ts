import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  varchar,
  integer,
  date,
  text,
  boolean,
  numeric,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ─── Melting register ─────────────────────────────────────────────────────────
// RECORD ONLY. A melting entry is a plain log of metal melted down — it is
// deliberately NOT written into entry_groups/entries and never moves stock or
// any balance. Nothing else in the system reads these tables.

// User-managed list of metals a melting entry can be filed under.
export const metals = pgTable(
  "metals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 100 }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("metals_name_lower_unique").on(sql`lower(${t.name})`)],
);

export const meltingEntries = pgTable(
  "melting_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entry_no: integer("entry_no").notNull(),
    date: date("date").notNull(),
    // Legacy single metal (pre-0022). New entries use melting_alloys instead.
    metal_id: uuid("metal_id").references(() => metals.id),
    remarks: text("remarks"),
    // Alloy calculator (0022): target touch, resulting final weight, and the
    // total grams of alloy metal to add. All null when no required touch set.
    required_touch: numeric("required_touch", { precision: 6, scale: 2 }),
    final_weight: numeric("final_weight", { precision: 20, scale: 3 }),
    alloy_total: numeric("alloy_total", { precision: 20, scale: 3 }),
    is_deleted: boolean("is_deleted").default(false).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("melting_entries_date_idx").on(t.date)],
);

export const meltingLines = pgTable("melting_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  melting_id: uuid("melting_id")
    .notNull()
    .references(() => meltingEntries.id, { onDelete: "cascade" }),
  sort_order: integer("sort_order").notNull(),
  weight: numeric("weight", { precision: 20, scale: 3 }).notNull(),
  touch: numeric("touch", { precision: 6, scale: 2 }),
  wastage_percent: numeric("wastage_percent", { precision: 6, scale: 2 }),
  pure: numeric("pure", { precision: 20, scale: 3 }),
  wastage: numeric("wastage", { precision: 20, scale: 3 }),
  total_pure: numeric("total_pure", { precision: 20, scale: 3 }),
  quantity: integer("quantity"),
});

// Alloy metals added to bring the melt down to required_touch. grams is the
// server-computed share of melting_entries.alloy_total.
export const meltingAlloys = pgTable(
  "melting_alloys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    melting_id: uuid("melting_id")
      .notNull()
      .references(() => meltingEntries.id, { onDelete: "cascade" }),
    metal_id: uuid("metal_id")
      .notNull()
      .references(() => metals.id),
    sort_order: integer("sort_order").notNull(),
    share_percent: numeric("share_percent", { precision: 6, scale: 2 }).notNull(),
    grams: numeric("grams", { precision: 20, scale: 3 }).notNull(),
  },
  (t) => [
    index("melting_alloys_melting_id_idx").on(t.melting_id),
    index("melting_alloys_metal_id_idx").on(t.metal_id),
  ],
);
