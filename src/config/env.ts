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
  // Login location: path to a MaxMind GeoLite2-City.mmdb file. Missing file → no city/country.
  GEOIP_DB_PATH: z.string().default("./geoip/GeoLite2-City.mmdb"),
  // Login history / activity / audit rows older than this are deleted daily.
  LOG_RETENTION_DAYS: z.string().default("365"),
  // Bill / data change history (data_audit_log) — 8 years by default (GST / IT records).
  DATA_AUDIT_RETENTION_DAYS: z.string().default("2922"),
  // Secret for the audit hash chain (HMAC-SHA256). Missing → un-keyed SHA-256 + warning.
  AUDIT_CHAIN_KEY: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, "AUDIT_CHAIN_KEY must be 64 hex characters (openssl rand -hex 32)")
      .optional(),
  ),
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
  LOG_RETENTION_DAYS: Number(parsed.data.LOG_RETENTION_DAYS),
  DATA_AUDIT_RETENTION_DAYS: Number(parsed.data.DATA_AUDIT_RETENTION_DAYS),
  IS_PROD: parsed.data.NODE_ENV === "production",
};
