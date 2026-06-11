import "./config/env"; // Validates all env variables at startup — if any are missing, the process exits here
import app from "./app";
import { env } from "./config/env";

// ─── Start server ─────────────────────────────────────────────────────────────
app.listen(env.PORT, () => {
  console.log(
    `✅ Gold Billing Server running on port ${env.PORT} (${env.NODE_ENV})`,
  );
});

// ─── Graceful shutdown on uncaught errors ─────────────────────────────────────
process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught Exception:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("❌ Unhandled Rejection:", reason);
  process.exit(1);
});
