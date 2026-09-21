import { sql } from "drizzle-orm";
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
  uniqueIndex,
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
  // Names are unique per account type AND role (customer_type), case- and
  // whitespace-insensitive, so "Brn", "brn" and " Brn " cannot coexist as
  // customers — but the same person CAN be a Customer, a Purchaser and a
  // Goldsmith at once, each as its own account with its own balance.
  // customer_type is coalesced because NULL never equals NULL in a unique index.
  // Soft-deleted and system accounts are excluded, so deleting an account frees
  // its name for reuse.
  // Two partial indexes rather than one over coalesce(customer_type): casting an
  // enum to text is not IMMUTABLE, so Postgres refuses it inside an index. The
  // first covers accounts that have a role; the second covers role-less ones,
  // which the first cannot guard because NULLs are all distinct to a unique index.
  uniqueIndex("accounts_type_role_name_unique")
    .on(table.type, table.customer_type, sql`lower(btrim(${table.name}))`)
    .where(
      sql`${table.is_deleted} = false AND ${table.is_system_account} = false AND ${table.customer_type} IS NOT NULL`,
    ),
  uniqueIndex("accounts_type_name_norole_unique")
    .on(table.type, sql`lower(btrim(${table.name}))`)
    .where(
      sql`${table.is_deleted} = false AND ${table.is_system_account} = false AND ${table.customer_type} IS NULL`,
    ),
]);
