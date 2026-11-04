import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  jsonb,
  bigint,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { appUsers } from "./settings";

// ─── user_devices ─────────────────────────────────────────────────────────────
// A browser is recognised by the httpOnly "device_id" cookie (random token,
// only its sha256 is stored). One row per (user, browser).

export const userDevices = pgTable(
  "user_devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    user_id: uuid("user_id")
      .references(() => appUsers.id, { onDelete: "cascade" })
      .notNull(),
    token_hash: varchar("token_hash", { length: 64 }).notNull(),
    browser: varchar("browser", { length: 100 }),
    os: varchar("os", { length: 100 }),
    device_type: varchar("device_type", { length: 20 }),
    label: varchar("label", { length: 100 }),
    first_seen_at: timestamp("first_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    last_seen_at: timestamp("last_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    last_ip: varchar("last_ip", { length: 45 }),
    last_location: varchar("last_location", { length: 150 }),
    revoked_at: timestamp("revoked_at", { withTimezone: true }),
    revoked_by: uuid("revoked_by").references(() => appUsers.id),
  },
  (t) => [
    uniqueIndex("user_devices_user_token_uq").on(t.user_id, t.token_hash),
    index("user_devices_user_id_idx").on(t.user_id),
  ],
);

// ─── login_history ────────────────────────────────────────────────────────────
// Every sign-in event (success, failure, 2FA, lockout, logout...) with IP,
// location and device. user_id is null when the username doesn't exist.

export const loginHistory = pgTable(
  "login_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    user_id: uuid("user_id").references(() => appUsers.id, { onDelete: "set null" }),
    username: varchar("username", { length: 100 }).notNull(),
    event: varchar("event", { length: 30 }).notNull(),
    reason: text("reason"),
    method: varchar("method", { length: 20 }),
    ip: varchar("ip", { length: 45 }),
    city: varchar("city", { length: 100 }),
    region: varchar("region", { length: 100 }),
    country: varchar("country", { length: 100 }),
    browser: varchar("browser", { length: 100 }),
    os: varchar("os", { length: 100 }),
    device_type: varchar("device_type", { length: 20 }),
    device_id: uuid("device_id").references(() => userDevices.id, { onDelete: "set null" }),
    new_device: boolean("new_device").default(false).notNull(),
    user_agent: varchar("user_agent", { length: 500 }),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("login_history_created_at_idx").on(t.created_at),
    index("login_history_user_id_idx").on(t.user_id),
    index("login_history_ip_idx").on(t.ip),
  ],
);

// ─── activity_logs ────────────────────────────────────────────────────────────
// Everyday work: every tRPC mutation (create / edit / delete ...) plus
// client-reported exports and prints. Inputs are never stored (may hold secrets).

export const activityLogs = pgTable(
  "activity_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    user_id: uuid("user_id").references(() => appUsers.id, { onDelete: "set null" }),
    username: varchar("username", { length: 100 }),
    module: varchar("module", { length: 50 }).notNull(),
    action: varchar("action", { length: 50 }).notNull(),
    procedure: varchar("procedure", { length: 150 }),
    record_ref: varchar("record_ref", { length: 100 }),
    success: boolean("success").default(true).notNull(),
    error: text("error"),
    ip: varchar("ip", { length: 45 }),
    device_id: uuid("device_id").references(() => userDevices.id, { onDelete: "set null" }),
    browser: varchar("browser", { length: 100 }),
    os: varchar("os", { length: 100 }),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("activity_logs_created_at_idx").on(t.created_at),
    index("activity_logs_user_id_idx").on(t.user_id),
    index("activity_logs_module_idx").on(t.module),
  ],
);

// ─── audit_logs ───────────────────────────────────────────────────────────────
// Security + admin changes with old → new values.
// changes = [{ field, from, to }] (never password hashes / secrets).
// actor_user_id null = system (lockout, auto IP block, CLI script).

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actor_user_id: uuid("actor_user_id").references(() => appUsers.id, { onDelete: "set null" }),
    actor_username: varchar("actor_username", { length: 100 }),
    action: varchar("action", { length: 60 }).notNull(),
    target_type: varchar("target_type", { length: 40 }).notNull(),
    target_id: varchar("target_id", { length: 100 }),
    target_label: varchar("target_label", { length: 200 }),
    changes: jsonb("changes").$type<Array<{ field: string; from: unknown; to: unknown }>>(),
    reason: text("reason"),
    ip: varchar("ip", { length: 45 }),
    user_agent: varchar("user_agent", { length: 500 }),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    // Hash chain (src/modules/audit/sealer.ts) — written once by the sealer job;
    // the database refuses any other UPDATE / DELETE (migration 0025).
    seal_seq: bigint("seal_seq", { mode: "bigint" }).unique(),
    prev_hash: varchar("prev_hash", { length: 64 }),
    row_hash: varchar("row_hash", { length: 64 }),
  },
  (t) => [
    index("audit_logs_created_at_idx").on(t.created_at),
    index("audit_logs_actor_idx").on(t.actor_user_id),
    index("audit_logs_action_idx").on(t.action),
  ],
);
