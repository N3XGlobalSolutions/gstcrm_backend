import { env } from "@/config/env";
import jwt from "jsonwebtoken";
import crypto from "crypto";

export interface JwtPayload {
  id: string;
  username: string;
  user_group: string;
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"],
  });
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, env.JWT_SECRET) as JwtPayload;
}

// ─── Refresh token helpers ────────────────────────────────────────────────────
// Refresh tokens are opaque random bytes — we store only the SHA-256 hash.

export function generateRefreshToken(): string {
  return crypto.randomBytes(64).toString("hex");
}

export function hashRefreshToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function refreshTokenExpiresAt(): Date {
  const d = new Date();
  d.setDate(d.getDate() + env.REFRESH_TOKEN_EXPIRES_IN_DAYS);
  return d;
}
