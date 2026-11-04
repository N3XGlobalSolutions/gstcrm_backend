import {
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { appUsers } from "./settings";
import { userDevices } from "./security-logs";

// ─── refresh_tokens ───────────────────────────────────────────────────────────

export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    user_id: uuid("user_id")
      .references(() => appUsers.id, { onDelete: "cascade" })
      .notNull(),
    token_hash: text("token_hash").unique().notNull(),
    ip: varchar("ip", { length: 45 }),
    user_agent: varchar("user_agent", { length: 500 }),
    // The browser (user_devices row) this session belongs to; null on tokens
    // issued before device recognition (0024).
    device_id: uuid("device_id").references(() => userDevices.id, { onDelete: "set null" }),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("refresh_tokens_user_id_idx").on(t.user_id),
    index("refresh_tokens_expires_at_idx").on(t.expires_at),
  ],
);
