import {
  pgTable,
  uuid,
  integer,
  varchar,
  text,
  timestamp,
  boolean,
  numeric,
} from "drizzle-orm/pg-core";

// ─── app_users ────────────────────────────────────────────────────────────────

export const appUsers = pgTable("app_users", {
  id: uuid("id").primaryKey().defaultRandom(),
  entry_no: integer("entry_no").unique().notNull(),
  username: varchar("username", { length: 100 }).unique().notNull(),
  password_hash: text("password_hash").notNull(),
  user_group: varchar("user_group", { length: 50 }),
  is_deleted: boolean("is_deleted").default(false).notNull(),
  created_at: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// ─── user_form_permissions ────────────────────────────────────────────────────

export const userFormPermissions = pgTable("user_form_permissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  user_id: uuid("user_id")
    .references(() => appUsers.id)
    .notNull(),
  module: varchar("module", { length: 100 }).notNull(),
  form_name: varchar("form_name", { length: 100 }).notNull(),
  allowed: boolean("allowed").default(false).notNull(),
});

// ─── user_activity_permissions ────────────────────────────────────────────────

export const userActivityPermissions = pgTable("user_activity_permissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  user_id: uuid("user_id")
    .references(() => appUsers.id)
    .notNull(),
  can_view: boolean("can_view").default(false).notNull(),
  can_edit: boolean("can_edit").default(false).notNull(),
  can_delete: boolean("can_delete").default(false).notNull(),
});

// ─── print_templates ──────────────────────────────────────────────────────────

export const printTemplates = pgTable("print_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  entry_no: integer("entry_no").unique().notNull(),
  template_name: varchar("template_name", { length: 200 }).notNull(),
  status: boolean("status").default(true).notNull(),
  created_at: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// ─── company_details ──────────────────────────────────────────────────────────

export const companyDetails = pgTable("company_details", {
  id: uuid("id").primaryKey().defaultRandom(),
  company_name: varchar("company_name", { length: 300 }),
  address: text("address"),
  phone: varchar("phone", { length: 20 }),
  email: varchar("email", { length: 200 }),
  gst_no: varchar("gst_no", { length: 20 }),
  pan_no: varchar("pan_no", { length: 10 }),
  bank_details: text("bank_details"),
  logo_url: varchar("logo_url", { length: 500 }),

  // New Fields
  businessName: varchar("business_name", { length: 300 }),
  addressLine1: text("address_line1"),
  city: varchar("city", { length: 100 }),
  pincode: varchar("pincode", { length: 20 }),
  state: varchar("state", { length: 100 }),
  stateCode: varchar("state_code", { length: 10 }),
  country: varchar("country", { length: 100 }),
  phoneNumber: varchar("phone_number", { length: 50 }),
  gstin: varchar("gstin", { length: 50 }),
  panNumber: varchar("pan_number", { length: 50 }),
  placeOfSupply: varchar("place_of_supply", { length: 100 }),
  businessType: varchar("business_type", { length: 100 }),

  // Default TDS/TCS % pre-filled on Purchase and Sales bills when the tax is toggled on.
  defaultTdsPercent: numeric("default_tds_percent", { precision: 5, scale: 3 }).default("0.01"),
  defaultTcsPercent: numeric("default_tcs_percent", { precision: 5, scale: 3 }).default("0.01"),

  updated_at: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// ─── tax_master ───────────────────────────────────────────────────────────────

export const taxMaster = pgTable("tax_master", {
  id: uuid("id").primaryKey().defaultRandom(),
  entry_no: integer("entry_no").unique().notNull(),
  category: varchar("category", { length: 50 }).notNull(), // 'ITEM_TAX' | 'HSN_SAC' | 'TDS_TCS'
  name: varchar("name", { length: 200 }).notNull(),
  code: varchar("code", { length: 50 }),
  percentage: numeric("percentage", { precision: 5, scale: 2 }).notNull(),
  is_deleted: boolean("is_deleted").default(false).notNull(),
  created_at: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
