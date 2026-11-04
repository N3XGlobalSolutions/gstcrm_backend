// ─────────────────────────────────────────────────────────────────────────────
// Device recognition (ported from Gold CRM for Login History).
//
// A browser is identified by the httpOnly "device_id" cookie (32 random bytes,
// hex). Only its sha256 is stored, one user_devices row per (user, browser).
// A sign-in from a browser with no row — or whose row was signed out — is a
// NEW DEVICE (login_history.new_device).
//
// GST CRM has no "My devices" screen yet, so listing / renaming / signing a
// device out are not ported; a row is only ever created or touched here.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from "crypto";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { userDevices } from "@/db/schema";
import { parseUserAgent } from "./userAgent";

export const DEVICE_COOKIE = "device_id";
export const DEVICE_COOKIE_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;

export function generateDeviceToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function hashDeviceToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function isValidDeviceToken(token: unknown): token is string {
  return typeof token === "string" && /^[0-9a-f]{64}$/.test(token);
}

// ─── Upsert at sign-in ────────────────────────────────────────────────────────

/**
 * Record this browser for the user. Atomic: a signed-out row is re-activated by
 * a conditional UPDATE (… WHERE revoked_at IS NOT NULL RETURNING), otherwise an
 * INSERT … ON CONFLICT reports via xmax = 0 whether the row was just created.
 */
export async function upsertDevice(input: {
  userId: string;
  rawToken: string;
  ip: string | null;
  userAgent: string | null;
  location: string | null;
}): Promise<{ id: string; newDevice: boolean }> {
  const ua = parseUserAgent(input.userAgent);
  const tokenHash = hashDeviceToken(input.rawToken);
  const meta = {
    browser: ua.browser,
    os: ua.os,
    device_type: ua.deviceType,
    last_seen_at: new Date(),
    last_ip: input.ip?.slice(0, 45) ?? null,
    last_location: input.location?.slice(0, 150) ?? null,
  };

  const [reactivated] = await db
    .update(userDevices)
    .set({ ...meta, revoked_at: null, revoked_by: null })
    .where(
      and(
        eq(userDevices.user_id, input.userId),
        eq(userDevices.token_hash, tokenHash),
        isNotNull(userDevices.revoked_at),
      ),
    )
    .returning({ id: userDevices.id });
  if (reactivated) return { id: reactivated.id, newDevice: true };

  const [row] = await db
    .insert(userDevices)
    .values({ user_id: input.userId, token_hash: tokenHash, ...meta })
    .onConflictDoUpdate({ target: [userDevices.user_id, userDevices.token_hash], set: meta })
    .returning({ id: userDevices.id, inserted: sql<boolean>`(xmax = 0)` });
  if (!row) throw new Error("Could not record the device");
  return { id: row.id, newDevice: row.inserted === true };
}

/** Refresh: bump last_seen_at / last_ip (best-effort). */
export function touchDevice(deviceId: string, ip: string | null): void {
  db.update(userDevices)
    .set({ last_seen_at: new Date(), last_ip: ip?.slice(0, 45) ?? null })
    .where(eq(userDevices.id, deviceId))
    .catch((err) => console.error("DEVICES: failed to update last seen", err));
}
