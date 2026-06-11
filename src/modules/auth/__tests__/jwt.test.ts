import { describe, it, expect } from "bun:test";
import { signToken, verifyToken, generateRefreshToken, hashRefreshToken, refreshTokenExpiresAt } from "@/config/jwt";

describe("jwt helpers", () => {
  const payload = { id: "abc-123", username: "testuser", user_group: "admin" };

  describe("signToken / verifyToken", () => {
    it("round-trips the payload", () => {
      const token = signToken(payload);
      const decoded = verifyToken(token);
      expect(decoded.id).toBe(payload.id);
      expect(decoded.username).toBe(payload.username);
      expect(decoded.user_group).toBe(payload.user_group);
    });

    it("throws on a tampered token", () => {
      const token = signToken(payload);
      const tampered = token.slice(0, -5) + "XXXXX";
      expect(() => verifyToken(tampered)).toThrow();
    });

    it("throws on an empty string", () => {
      expect(() => verifyToken("")).toThrow();
    });
  });

  describe("generateRefreshToken", () => {
    it("returns a 128-character hex string", () => {
      const token = generateRefreshToken();
      expect(token).toHaveLength(128);
      expect(/^[0-9a-f]+$/.test(token)).toBe(true);
    });

    it("produces unique tokens on each call", () => {
      const a = generateRefreshToken();
      const b = generateRefreshToken();
      expect(a).not.toBe(b);
    });
  });

  describe("hashRefreshToken", () => {
    it("produces the same hash for the same input", () => {
      const token = generateRefreshToken();
      expect(hashRefreshToken(token)).toBe(hashRefreshToken(token));
    });

    it("produces different hashes for different inputs", () => {
      const a = generateRefreshToken();
      const b = generateRefreshToken();
      expect(hashRefreshToken(a)).not.toBe(hashRefreshToken(b));
    });

    it("returns a 64-character hex string (SHA-256)", () => {
      const hash = hashRefreshToken("any-value");
      expect(hash).toHaveLength(64);
      expect(/^[0-9a-f]+$/.test(hash)).toBe(true);
    });
  });

  describe("refreshTokenExpiresAt", () => {
    it("returns a future date", () => {
      const expiry = refreshTokenExpiresAt();
      expect(expiry.getTime()).toBeGreaterThan(Date.now());
    });

    it("is approximately REFRESH_TOKEN_EXPIRES_IN_DAYS days in the future", () => {
      const days = Number(process.env.REFRESH_TOKEN_EXPIRES_IN_DAYS ?? 7);
      const expiry = refreshTokenExpiresAt();
      const diffMs = expiry.getTime() - Date.now();
      const diffDays = diffMs / (1000 * 60 * 60 * 24);
      expect(diffDays).toBeGreaterThan(days - 0.1);
      expect(diffDays).toBeLessThan(days + 0.1);
    });
  });
});
