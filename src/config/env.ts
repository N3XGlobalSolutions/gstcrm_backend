import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  JWT_SECRET: z
    .string()
    .min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_EXPIRES_IN: z
    .string()
    .default("15m"),
  REFRESH_TOKEN_SECRET: z
    .string()
    .min(32, "REFRESH_TOKEN_SECRET must be at least 32 characters"),
  REFRESH_TOKEN_EXPIRES_IN_DAYS: z.string().default("7"),
  FRONTEND_URL: z.string().url("FRONTEND_URL must be a valid URL"),
  PORT: z.string().default("3001"),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  BCRYPT_ROUNDS: z.string().default("12"),
  BACKUP_ENCRYPTION_PASSWORD: z.string().min(6, "BACKUP_ENCRYPTION_PASSWORD must be at least 6 characters"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = {
  ...parsed.data,
  PORT: Number(parsed.data.PORT),
  BCRYPT_ROUNDS: Number(parsed.data.BCRYPT_ROUNDS),
  REFRESH_TOKEN_EXPIRES_IN_DAYS: Number(parsed.data.REFRESH_TOKEN_EXPIRES_IN_DAYS),
  IS_PROD: parsed.data.NODE_ENV === "production",
};
