import "./config/env"; // Validates all env variables at startup — if any are missing, the process exits here
import app from "./app";
import { env } from "./config/env";
import { db } from "./db";
import { migrate } from "drizzle-orm/postgres-js/migrator";

// ─── Run Migrations and Start server ──────────────────────────────────────────
async function start() {
  try {
    console.log("⏳ Running database migrations...");
    await migrate(db, { migrationsFolder: "./src/db/migrations" });
    console.log("✅ Database migrations completed successfully!");
  } catch (error) {
    console.error("❌ Migration failed:", error);
    process.exit(1);
  }

  app.listen(env.PORT, () => {
    console.log(
      `✅ Gold Billing Server running on port ${env.PORT} (${env.NODE_ENV})`,
    );
  });
}

start();

// ─── Graceful shutdown on uncaught errors ─────────────────────────────────────
process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught Exception:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("❌ Unhandled Rejection:", reason);
  process.exit(1);
});
