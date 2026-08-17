import {
  pgTable,
  uuid,
  integer,
  varchar,
  text,
  timestamp,
  boolean,
  numeric,
  pgEnum,
  unique,
} from "drizzle-orm/pg-core";

// ─── Enums ────────────────────────────────────────────────────────────────────

export const accountTypeEnum = pgEnum("account_type", [
  "SHOP",
  "CUSTOMER",
  "GOLDSMITH",
  "CASH",
  "BANK",
  "EXPENSE",
  "LOSS",
  "OPENING_STOCK",
]);

export const customerTypeEnum = pgEnum("customer_type", [
  "PURCHASER",
  "CUSTOMER",
  "GOLD_SMITH",
  "SALES_MAN",
  "LABOUR_BILL",
]);

// ─── accounts ─────────────────────────────────────────────────────────────────

export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  entry_no: integer("entry_no").notNull(),
  name: varchar("name", { length: 200 }).notNull(),
  type: accountTypeEnum("type").notNull(),
  customer_type: customerTypeEnum("customer_type"),
  gst_no: varchar("gst_no", { length: 20 }),
  pan_no: varchar("pan_no", { length: 10 }),
  state_code: varchar("state_code", { length: 10 }),
  place_of_supply: varchar("place_of_supply", { length: 100 }),
  address: text("address"),
  phone: varchar("phone", { length: 15 }),
  email: varchar("email", { length: 200 }),
  website: varchar("website", { length: 200 }),
  bank_name: varchar("bank_name", { length: 200 }),
  bank_account_no: varchar("bank_account_no", { length: 30 }),
  ifsc_code: varchar("ifsc_code", { length: 15 }),
  // Per-account TDS/TCS % override — used on Purchase/Sales/Labour Bill bills for
  // this account instead of the company-wide default when set (see settings.company).
  default_tds_percent: numeric("default_tds_percent", { precision: 5, scale: 3 }),
  default_tcs_percent: numeric("default_tcs_percent", { precision: 5, scale: 3 }),
  // Stored for reference — NOT the source of truth for balance (use getBalance)
  opening_pure_balance: numeric("opening_pure_balance", {
    precision: 20,
    scale: 8,
  })
    .default("0")
    .notNull(),
  opening_cash_balance: numeric("opening_cash_balance", {
    precision: 20,
    scale: 2,
  })
    .default("0")
    .notNull(),
  is_system_account: boolean("is_system_account").default(false).notNull(),
  is_deleted: boolean("is_deleted").default(false).notNull(),
  created_at: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
}, (table) => [
  unique("accounts_type_entry_no_unique").on(table.type, table.entry_no),
]);
