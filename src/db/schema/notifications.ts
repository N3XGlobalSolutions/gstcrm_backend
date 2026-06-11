import {
  pgTable,
  uuid,
  integer,
  text,
  timestamp,
  boolean,
} from "drizzle-orm/pg-core";
import { appUsers } from "./settings";

// ─── notifications ────────────────────────────────────────────────────────────

export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  entry_no: integer("entry_no").unique().notNull(),
  message: text("message").notNull(),
  created_by: uuid("created_by")
    .references(() => appUsers.id)
    .notNull(),
  is_read: boolean("is_read").default(false).notNull(),
  is_deleted: boolean("is_deleted").default(false).notNull(),
  created_at: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
