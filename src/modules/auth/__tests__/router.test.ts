/**
 * Auth router integration tests.
 *
 * These tests require a running Postgres instance with DATABASE_URL set and
 * the schema already migrated.  They use supertest to hit the Express app
 * directly without starting an HTTP server.
 *
 * Run with:
 *   bun test src/modules/auth/__tests__/router.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import supertest from "supertest";
import app from "@/app";
import { db } from "@/db";
import { appUsers, refreshTokens, loginAttempts } from "@/db/schema";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";

const TEST_USER = {
  entry_no: 9998,
  username: "test_auth_user",
  password: "testpassword",
  password_hash: "",
  user_group: "admin",
};

let createdUserId: string;

beforeAll(async () => {
  TEST_USER.password_hash = await bcrypt.hash(TEST_USER.password, 4); // low rounds for speed
  const [user] = await db
    .insert(appUsers)
    .values({
      entry_no: TEST_USER.entry_no,
      username: TEST_USER.username,
      password_hash: TEST_USER.password_hash,
      user_group: TEST_USER.user_group,
    })
    .returning({ id: appUsers.id });
  createdUserId = user!.id;
});

afterAll(async () => {
  await db.delete(refreshTokens).where(eq(refreshTokens.user_id, createdUserId));
  await db.delete(loginAttempts).where(eq(loginAttempts.username, TEST_USER.username));
  await db.delete(appUsers).where(eq(appUsers.id, createdUserId));
});

describe("POST /api/auth/login", () => {
  it("returns 400 when username is too short", async () => {
    const res = await supertest(app)
      .post("/api/auth/login")
      .send({ username: "ab", password: "testpassword" });
    expect(res.status).toBe(400);
    expect(res.body.message).toBeTruthy();
  });

  it("returns 400 when password is too short", async () => {
    const res = await supertest(app)
      .post("/api/auth/login")
      .send({ username: TEST_USER.username, password: "short" });
    expect(res.status).toBe(400);
  });

  it("returns 401 for wrong credentials", async () => {
    const res = await supertest(app)
      .post("/api/auth/login")
      .send({ username: TEST_USER.username, password: "wrongpassword123" });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Invalid username or password");
  });

  it("returns 200 with token and refresh cookie on success", async () => {
    const res = await supertest(app)
      .post("/api/auth/login")
      .send({ username: TEST_USER.username, password: TEST_USER.password });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.username).toBe(TEST_USER.username);
    expect(res.headers["set-cookie"]).toBeDefined();
    const setCookieHeader = res.headers["set-cookie"];
    const cookie = Array.isArray(setCookieHeader) ? setCookieHeader[0]! : setCookieHeader!;
    expect(cookie).toContain("refresh_token=");
    expect(cookie).toContain("HttpOnly");
  });

  it("records the attempt in login_attempts", async () => {
    await supertest(app)
      .post("/api/auth/login")
      .send({ username: TEST_USER.username, password: "wrongpassword123" });

    // Give fire-and-forget a tick to complete
    await new Promise((r) => setTimeout(r, 50));

    const rows = await db
      .select()
      .from(loginAttempts)
      .where(eq(loginAttempts.username, TEST_USER.username));
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe("POST /api/auth/refresh", () => {
  it("returns 401 with no cookie", async () => {
    const res = await supertest(app).post("/api/auth/refresh");
    expect(res.status).toBe(401);
  });

  it("issues a new access token with a valid cookie", async () => {
    const loginRes = await supertest(app)
      .post("/api/auth/login")
      .send({ username: TEST_USER.username, password: TEST_USER.password });

    const setCookieHeader = loginRes.headers["set-cookie"];
    const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : setCookieHeader ? [setCookieHeader] : [];
    const refreshCookie = cookies.find((c: string) => c.startsWith("refresh_token="));
    expect(refreshCookie).toBeTruthy();

    const cookieValue = refreshCookie!.split(";")[0]; // "refresh_token=<value>"
    const refreshRes = await supertest(app)
      .post("/api/auth/refresh")
      .set("Cookie", cookieValue!);

    expect(refreshRes.status).toBe(200);
    expect(refreshRes.body.token).toBeTruthy();
    expect(refreshRes.body.user.id).toBe(createdUserId);
  });
});

describe("POST /api/auth/logout", () => {
  it("clears the refresh cookie", async () => {
    const loginRes = await supertest(app)
      .post("/api/auth/login")
      .send({ username: TEST_USER.username, password: TEST_USER.password });

    const setCookieHeader = loginRes.headers["set-cookie"];
    const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : setCookieHeader ? [setCookieHeader] : [];
    const refreshCookie = cookies.find((c: string) => c.startsWith("refresh_token="));
    const cookieValue = refreshCookie!.split(";")[0]!;

    const logoutRes = await supertest(app)
      .post("/api/auth/logout")
      .set("Cookie", cookieValue);

    expect(logoutRes.status).toBe(200);
    expect(logoutRes.body.success).toBe(true);

    // Cookie should be cleared (Max-Age=0 or Expires in past)
    const logoutSetCookieHeader = logoutRes.headers["set-cookie"];
    const setCookie = Array.isArray(logoutSetCookieHeader) ? logoutSetCookieHeader : logoutSetCookieHeader ? [logoutSetCookieHeader] : [];
    const cleared = setCookie.find((c: string) => c.startsWith("refresh_token="));
    expect(cleared).toBeTruthy();
    expect(cleared).toMatch(/Max-Age=0|Expires=.*1970/i);
  });
});

describe("GET /api/auth/me", () => {
  it("returns 401 without a token", async () => {
    const res = await supertest(app).get("/api/auth/me");
    expect(res.status).toBe(401);
  });

  it("returns user data with a valid token", async () => {
    const loginRes = await supertest(app)
      .post("/api/auth/login")
      .send({ username: TEST_USER.username, password: TEST_USER.password });

    const meRes = await supertest(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${loginRes.body.token}`);

    expect(meRes.status).toBe(200);
    expect(meRes.body.user.username).toBe(TEST_USER.username);
  });

  it("returns 401 with an invalid token", async () => {
    const res = await supertest(app)
      .get("/api/auth/me")
      .set("Authorization", "Bearer not.a.valid.token");
    expect(res.status).toBe(401);
  });
});
