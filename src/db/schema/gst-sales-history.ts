import {
  pgTable,
  uuid,
  text,
  timestamp,
  numeric,
} from "drizzle-orm/pg-core";
import { accounts } from "./accounts";

export const gstSalesHistory = pgTable("gst_sales_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  sale_id: uuid("sale_id").notNull(),
  entry_no: text("entry_no").notNull(),
  bill_no: text("bill_no").notNull(),
  date: timestamp("date", { withTimezone: true }).notNull(),
  account_id: uuid("account_id")
    .references(() => accounts.id)
    .notNull(),
  pure: numeric("pure", { precision: 20, scale: 8 }).notNull(),
  cash: numeric("cash", { precision: 20, scale: 2 }).notNull(),
  gst_amount: numeric("gst_amount", { precision: 20, scale: 2 }).notNull(),
  tds_amount: numeric("tds_amount", { precision: 20, scale: 2 }).default("0"),
  tcs_amount: numeric("tcs_amount", { precision: 20, scale: 2 }).default("0"),
  type: text("type").default("SALE").notNull(),
  rate: numeric("rate", { precision: 20, scale: 2 }).notNull(),
  item_type: text("item_type").notNull(),
  bal_pure: numeric("bal_pure", { precision: 20, scale: 8 }).notNull(),
  bal_cash: numeric("bal_cash", { precision: 20, scale: 2 }).notNull(),
  bank_paid: numeric("bank_paid", { precision: 20, scale: 2 }).default("0"),
  bank_receive: numeric("bank_receive", { precision: 20, scale: 2 }).default("0"),
  cash_paid: numeric("cash_paid", { precision: 20, scale: 2 }).default("0"),
  created_at: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
