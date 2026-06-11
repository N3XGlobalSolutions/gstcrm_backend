import { z } from "zod";

// ─── Login ────────────────────────────────────────────────────────────────────

export const LoginInputSchema = z.object({
  username: z.string().min(3, "Username must be at least 3 characters"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  rememberMe: z.boolean().optional().default(false),
});

export type LoginInput = z.infer<typeof LoginInputSchema>;

// ─── Responses ────────────────────────────────────────────────────────────────

export const UserSchema = z.object({
  id: z.string().uuid(),
  username: z.string(),
  user_group: z.string().nullable(),
});

export type UserPayload = z.infer<typeof UserSchema>;

export const LoginResponseSchema = z.object({
  token: z.string(),
  user: UserSchema,
});

export const MeResponseSchema = z.object({
  user: UserSchema,
});
