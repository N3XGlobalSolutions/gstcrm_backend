// ─────────────────────────────────────────────────────────────────────────────
// Login history — one row per sign-in event, with location (offline GeoIP) and
// parsed browser / OS / device type. recordLoginEvent never throws.
// ─────────────────────────────────────────────────────────────────────────────

import { count, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { loginHistory } from "@/db/schema";
import { lookupIp } from "./geo";
import { normalizeIp } from "./ip";
import { parseUserAgent } from "./userAgent";

export type LoginEvent =
  | "login_success"
  | "login_failed"
  | "mfa_success"
  | "mfa_failed"
  | "mfa_locked"
  | "account_locked"
  | "password_change_required"
  | "password_changed"
  | "logout";

export type LoginFailReason = "wrong_password" | "unknown_user" | "account_locked" | "ip_blocked" | "mfa_unavailable";

export interface LoginEventEntry {
  userId: string | null;
  username: string;
  event: LoginEvent;
  reason?: string | null;
  method?: string | null;
  ip: string | null;
  userAgent: string | null;
  deviceId?: string | null;
  newDevice?: boolean;
}

export async function recordLoginEvent(entry: LoginEventEntry): Promise<void> {
  try {
    const ip = normalizeIp(entry.ip);
    const geo = await lookupIp(ip);
    const ua = parseUserAgent(entry.userAgent);
    await db.insert(loginHistory).values({
      user_id: entry.userId,
      username: (entry.username || "—").slice(0, 100),
      event: entry.event,
      reason: entry.reason ?? null,
      method: entry.method?.slice(0, 20) ?? null,
      ip: ip?.slice(0, 45) ?? null,
      city: geo.city,
      region: geo.region,
      country: geo.country,
      browser: ua.browser,
      os: ua.os,
      device_type: ua.deviceType,
      device_id: entry.deviceId ?? null,
      new_device: entry.newDevice ?? false,
      user_agent: entry.userAgent?.slice(0, 500) ?? null,
    });
  } catch (err) {
    console.error("LOGIN HISTORY: failed to record event", entry.event, err);
  }
}

// ─── Reading ──────────────────────────────────────────────────────────────────

export interface LoginHistoryRow {
  id: string;
  user_id: string | null;
  username: string;
  event: string;
  reason: string | null;
  method: string | null;
  ip: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  browser: string | null;
  os: string | null;
  device_type: string | null;
  new_device: boolean;
  created_at: Date;
}

/** Select list for LoginHistoryRow (shared with the logs router). */
export const loginHistoryColumns = {
  id: loginHistory.id,
  user_id: loginHistory.user_id,
  username: loginHistory.username,
  event: loginHistory.event,
  reason: loginHistory.reason,
  method: loginHistory.method,
  ip: loginHistory.ip,
  city: loginHistory.city,
  region: loginHistory.region,
  country: loginHistory.country,
  browser: loginHistory.browser,
  os: loginHistory.os,
  device_type: loginHistory.device_type,
  new_device: loginHistory.new_device,
  created_at: loginHistory.created_at,
};

/** One user's own history, newest first. */
export async function listUserLoginHistory(
  userId: string,
  page: number,
  pageSize: number,
): Promise<{ rows: LoginHistoryRow[]; total: number }> {
  const [rows, [totalRow]] = await Promise.all([
    db
      .select(loginHistoryColumns)
      .from(loginHistory)
      .where(eq(loginHistory.user_id, userId))
      .orderBy(desc(loginHistory.created_at))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ n: count() }).from(loginHistory).where(eq(loginHistory.user_id, userId)),
  ]);
  return { rows, total: Number(totalRow?.n ?? 0) };
}
