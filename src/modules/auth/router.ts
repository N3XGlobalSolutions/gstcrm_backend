import { Router } from "express";
import type { Request } from "express";
import { db } from "@/db";
import { appUsers, loginAttempts, refreshTokens } from "@/db/schema";
import { eq, and, lt } from "drizzle-orm";
import bcrypt from "bcryptjs";
import {
  signToken,
  generateRefreshToken,
  hashRefreshToken,
  refreshTokenExpiresAt,
} from "@/config/jwt";
import { authMiddleware } from "@/middlewares/authMiddleware";
import { loginRateLimiter } from "@/middlewares/rateLimit";
import { LoginInputSchema } from "./schema";
import { env } from "@/config/env";

const authRouter = Router();

const ACCESS_COOKIE = "access_token";
const REFRESH_COOKIE = "refresh_token";

const isProd = env.IS_PROD || env.NODE_ENV === "production";

const accessCookieOptions = {
  httpOnly: true,
  secure: isProd,
  sameSite: isProd ? ("none" as const) : ("lax" as const),
  path: "/",
};

const refreshCookieOptions = {
  httpOnly: true,
  secure: isProd,
  sameSite: isProd ? ("none" as const) : ("lax" as const),
  path: "/api/auth",
};

// ─── POST /login ──────────────────────────────────────────────────────────────

authRouter.post("/login", loginRateLimiter, async (req, res): Promise<void> => {
  const ip = (req.ip ?? req.socket.remoteAddress ?? null) as string | null;
  const userAgent = (req.headers["user-agent"] ?? null) as string | null;

  const parsed = LoginInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid input" });
    return;
  }

  const { username, password, rememberMe } = parsed.data;

  try {
    const [user] = await db
      .select({
        id: appUsers.id,
        username: appUsers.username,
        user_group: appUsers.user_group,
        password_hash: appUsers.password_hash,
      })
      .from(appUsers)
      .where(and(eq(appUsers.username, username), eq(appUsers.is_deleted, false)))
      .limit(1);

    const valid = user ? await bcrypt.compare(password, user.password_hash!) : false;

    // Audit every attempt (fire-and-forget)
    db.insert(loginAttempts)
      .values({ username, ip, user_agent: userAgent, success: valid })
      .catch(() => undefined);

    if (!user || !valid) {
      res.status(401).json({ message: "Invalid username or password" });
      return;
    }

    // Prune expired tokens for this user (fire-and-forget)
    db.delete(refreshTokens)
      .where(and(eq(refreshTokens.user_id, user.id), lt(refreshTokens.expires_at, new Date())))
      .catch(() => undefined);

    const accessToken = signToken({
      id: user.id,
      username: user.username,
      user_group: user.user_group ?? "",
    });

    const rawRefresh = generateRefreshToken();
    // Remember me = 30 days; default = 7 days
    const refreshDays = rememberMe ? 30 : env.REFRESH_TOKEN_EXPIRES_IN_DAYS;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + refreshDays);

    await db.insert(refreshTokens).values({
      user_id: user.id,
      token_hash: hashRefreshToken(rawRefresh),
      ip,
      user_agent: userAgent,
      expires_at: expiresAt,
    });

    const refreshCookieOpts: Record<string, any> = { ...refreshCookieOptions };
    const accessCookieOpts: Record<string, any> = { ...accessCookieOptions };
    if (rememberMe) {
      refreshCookieOpts.expires = expiresAt;
      accessCookieOpts.expires = expiresAt;
    }

    res
      .cookie(ACCESS_COOKIE, accessToken, accessCookieOpts)
      .cookie(REFRESH_COOKIE, rawRefresh, refreshCookieOpts)
      .json({
        token: accessToken,
        user: { id: user.id, username: user.username, user_group: user.user_group },
      });
  } catch (error) {
    console.error("LOGIN ERROR:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// ─── POST /refresh ────────────────────────────────────────────────────────────
// Accepts the httpOnly refresh_token cookie and issues a new access token.
// Rotates the refresh token (old one is deleted, new one is set).

authRouter.post("/refresh", async (req, res): Promise<void> => {
  const rawRefresh: string | undefined = (req as Request & { cookies: Record<string, string> }).cookies[REFRESH_COOKIE];
  if (!rawRefresh) {
    res.clearCookie(ACCESS_COOKIE, accessCookieOptions).status(401).json({ message: "No refresh token" });
    return;
  }

  try {
    const hash = hashRefreshToken(rawRefresh);
    const [stored] = await db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.token_hash, hash))
      .limit(1);

    if (!stored || stored.expires_at < new Date()) {
      res
        .clearCookie(ACCESS_COOKIE, accessCookieOptions)
        .clearCookie(REFRESH_COOKIE, refreshCookieOptions)
        .status(401)
        .json({ message: "Invalid or expired refresh token" });
      return;
    }

    // Rotate — delete old, issue new
    await db.delete(refreshTokens).where(eq(refreshTokens.id, stored.id));

    const [user] = await db
      .select({ id: appUsers.id, username: appUsers.username, user_group: appUsers.user_group })
      .from(appUsers)
      .where(and(eq(appUsers.id, stored.user_id), eq(appUsers.is_deleted, false)))
      .limit(1);

    if (!user) {
      res
        .clearCookie(ACCESS_COOKIE, accessCookieOptions)
        .clearCookie(REFRESH_COOKIE, refreshCookieOptions)
        .status(401)
        .json({ message: "User not found" });
      return;
    }

    const ip = (req.ip ?? req.socket.remoteAddress ?? null) as string | null;
    const userAgent = (req.headers["user-agent"] ?? null) as string | null;
    const newRawRefresh = generateRefreshToken();

    // Check if the previous token was a remember-me token (duration > REFRESH_TOKEN_EXPIRES_IN_DAYS + 1)
    const diffMs = stored.expires_at.getTime() - stored.created_at.getTime();
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    const isRememberMe = diffDays > (env.REFRESH_TOKEN_EXPIRES_IN_DAYS + 1);

    const refreshDays = isRememberMe ? 30 : env.REFRESH_TOKEN_EXPIRES_IN_DAYS;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + refreshDays);

    await db.insert(refreshTokens).values({
      user_id: user.id,
      token_hash: hashRefreshToken(newRawRefresh),
      ip,
      user_agent: userAgent,
      expires_at: expiresAt,
    });

    const accessToken = signToken({
      id: user.id,
      username: user.username,
      user_group: user.user_group ?? "",
    });

    const refreshCookieOpts: Record<string, any> = { ...refreshCookieOptions };
    const accessCookieOpts: Record<string, any> = { ...accessCookieOptions };
    if (isRememberMe) {
      refreshCookieOpts.expires = expiresAt;
      accessCookieOpts.expires = expiresAt;
    }

    res
      .cookie(ACCESS_COOKIE, accessToken, accessCookieOpts)
      .cookie(REFRESH_COOKIE, newRawRefresh, refreshCookieOpts)
      .json({
        token: accessToken,
        user: { id: user.id, username: user.username, user_group: user.user_group },
      });
  } catch (error) {
    console.error("REFRESH ERROR:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// ─── POST /logout ─────────────────────────────────────────────────────────────

authRouter.post("/logout", async (req, res): Promise<void> => {
  const rawRefresh: string | undefined = (req as Request & { cookies: Record<string, string> }).cookies[REFRESH_COOKIE];

  if (rawRefresh) {
    db.delete(refreshTokens)
      .where(eq(refreshTokens.token_hash, hashRefreshToken(rawRefresh)))
      .catch(() => undefined);
  }

  res
    .clearCookie(ACCESS_COOKIE, accessCookieOptions)
    .clearCookie(REFRESH_COOKIE, refreshCookieOptions)
    .json({ success: true });
});

// ─── GET /me ──────────────────────────────────────────────────────────────────
// Uses authMiddleware for token verification; returns a fresh DB read.

authRouter.get(
  "/me",
  authMiddleware as Parameters<typeof authRouter.get>[1],
  async (req, res): Promise<void> => {
    try {
      const userId = (req as Request & { appUser: { id: string } }).appUser.id;

      const [user] = await db
        .select({
          id: appUsers.id,
          username: appUsers.username,
          user_group: appUsers.user_group,
        })
        .from(appUsers)
        .where(and(eq(appUsers.id, userId), eq(appUsers.is_deleted, false)))
        .limit(1);

      if (!user) {
        res.status(404).json({ message: "User not found" });
        return;
      }

      res.json({ user });
    } catch {
      res.status(500).json({ message: "Internal server error" });
    }
  },
);

export default authRouter;
