import "./config/env"; // Validates all env variables at startup — if any are missing, the process exits here
import app from "./app";
import { env } from "./config/env";
import { db } from "./db";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { ensureSystemAccountsAndItems } from "./db/seed";

// ─── Neon Keep-Alive Ping ──────────────────────────────────────────────────────
function startKeepAlive() {
  const INTERVAL_MS = 3 * 60 * 1000; // 3 minutes
  setInterval(async () => {
    try {
      const start = performance.now();
      await db.execute(sql`SELECT 1`);
      const duration = performance.now() - start;
      console.log(`[Keep-Alive] Database pinged successfully in ${duration.toFixed(2)}ms`);
    } catch (error) {
      console.error("[Keep-Alive] Database ping failed:", error);
    }
  }, INTERVAL_MS);
}

// ─── Run Migrations and Start server ──────────────────────────────────────────
async function start() {
  try {
    console.log("⏳ Running database migrations...");
    await migrate(db, { migrationsFolder: "./src/db/migrations" });
    console.log("✅ Database migrations completed successfully!");

    await ensureSystemAccountsAndItems();
    console.log("✅ System accounts and items verified!");
  } catch (error) {
    console.error("❌ Migration/Seeding failed:", error);
    process.exit(1);
  }

  app.listen(env.PORT, () => {
    console.log(
      `✅ Gold Billing Server running on port ${env.PORT} (${env.NODE_ENV})`,
    );
    startKeepAlive();
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
