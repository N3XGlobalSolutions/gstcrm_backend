import {
  pgTable,
  uuid,
  integer,
  varchar,
  timestamp,
  boolean,
  pgEnum,
} from "drizzle-orm/pg-core";

// ─── Enums ────────────────────────────────────────────────────────────────────

export const itemTypeEnum = pgEnum("item_type", ["GOLD", "ORNAMENT", "MONEY"]);
export const itemUnitEnum = pgEnum("item_unit", ["GRAM", "PIECE", "RUPEE"]);

// ─── items ────────────────────────────────────────────────────────────────────

export const items = pgTable("items", {
  id: uuid("id").primaryKey().defaultRandom(),
  entry_no: integer("entry_no").unique().notNull(),
  name: varchar("name", { length: 100 }).notNull(),
  type: itemTypeEnum("type").notNull(),
  unit: itemUnitEnum("unit").notNull(),
  is_deleted: boolean("is_deleted").default(false).notNull(),
  created_at: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
