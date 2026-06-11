import {
  pgTable,
  uuid,
  varchar,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

// ─── login_attempts ───────────────────────────────────────────────────────────

export const loginAttempts = pgTable(
  "login_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    username: varchar("username", { length: 100 }).notNull(),
    ip: varchar("ip", { length: 45 }),
    user_agent: varchar("user_agent", { length: 500 }),
    success: boolean("success").notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("login_attempts_username_idx").on(t.username),
    index("login_attempts_created_at_idx").on(t.created_at),
  ],
);
