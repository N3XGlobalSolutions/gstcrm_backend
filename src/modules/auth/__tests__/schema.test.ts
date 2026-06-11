import { describe, it, expect } from "bun:test";
import { LoginInputSchema } from "../schema";

describe("LoginInputSchema", () => {
  it("accepts valid credentials", () => {
    const result = LoginInputSchema.safeParse({ username: "alice", password: "secret123" });
    expect(result.success).toBe(true);
  });

  it("rejects username shorter than 3 characters", () => {
    const result = LoginInputSchema.safeParse({ username: "ab", password: "secret123" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toContain("username");
    }
  });

  it("rejects password shorter than 8 characters", () => {
    const result = LoginInputSchema.safeParse({ username: "alice", password: "short" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toContain("password");
    }
  });

  it("rejects missing username", () => {
    const result = LoginInputSchema.safeParse({ password: "secret123" });
    expect(result.success).toBe(false);
  });

  it("rejects missing password", () => {
    const result = LoginInputSchema.safeParse({ username: "alice" });
    expect(result.success).toBe(false);
  });

  it("rejects empty object", () => {
    const result = LoginInputSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});
