import "@/config/env"; // Must be first import — validates env at startup
import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import * as trpcExpress from "@trpc/server/adapters/express";
import { requestLogger } from "@/middlewares/requestLogger";
import { logger } from "@/lib/logger";
import { createContext } from "@/lib/context";
import { appRouter } from "@/app.router";
import authRouter from "@/modules/auth/router";
import { globalErrorHandler } from "@/middlewares/errorHandler";
import { env } from "@/config/env";
import os from "os";
import { db } from "@/db";
import { sql } from "drizzle-orm";

const app = express();

// Use custom human-readable HTTP and tRPC logger
app.use(requestLogger);

// Trust first proxy so rate-limiter reads the real client IP from X-Forwarded-For
app.set("trust proxy", 1);

// ─── 1. Security headers ──────────────────────────────────────────────────────
app.use(helmet());

// ─── 2. CORS ──────────────────────────────────────────────────────────────────
const allowedOrigins = [
  env.FRONTEND_URL,
  "https://aarsanjewels.cloud",
  "https://www.aarsanjewels.cloud",
  "https://goldcrmfrontend.pages.dev",
  "http://localhost:5173",
  "http://localhost:5174"
];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like same-origin requests)
      if (!origin) return callback(null, true);
      
      // In development, dynamically allow any localhost origin
      if (env.NODE_ENV === "development" && (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:"))) {
        return callback(null, true);
      }

      // Dynamically allow any Cloudflare Pages preview/branch deployments and Workers deployments
      if (origin.endsWith(".pages.dev") || origin.endsWith(".workers.dev")) {
        return callback(null, true);
      }
      
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      } else {
        return callback(new Error("Not allowed by CORS"));
      }
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
  }),
);

// ─── 3. Body parsers & cookies ───────────────────────────────────────────────
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ─── 4. Auth routes ───────────────────────────────────────────────────────────
app.use("/api/auth", authRouter);

// ─── 5. Health check (no auth required) ──────────────────────────────────────
app.get("/api/health", (_req, res) => {
  try {
    const processUptime = process.uptime();
    const osUptime = os.uptime();
    const freemem = os.freemem();
    const totalmem = os.totalmem();
    const memoryUsage = process.memoryUsage();
    const loadavg = os.loadavg();
    
    res.status(200).json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      uptime: {
        process: `${Math.floor(processUptime)}s`,
        system: `${Math.floor(osUptime)}s`,
      },
      processMemory: {
        rss: `${Math.round(memoryUsage.rss / 1024 / 1024)}MB`,
        heapTotal: `${Math.round(memoryUsage.heapTotal / 1024 / 1024)}MB`,
        heapUsed: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB`,
      },
      systemMemory: {
        free: `${Math.round(freemem / 1024 / 1024)}MB`,
        total: `${Math.round(totalmem / 1024 / 1024)}MB`,
        usagePercentage: `${Math.round(((totalmem - freemem) / totalmem) * 100)}%`,
      },
      cpu: {
        loadAverage: loadavg,
        cores: os.cpus().length,
      }
    });
  } catch (error: any) {
    console.error("Health check failed:", error);
    res.status(500).json({
      status: "unhealthy",
      timestamp: new Date().toISOString(),
    });
  }
});

// ─── 5.1 Database Health check (no auth required) ───────────────────────────
app.get("/api/health3", async (_req, res) => {
  try {
    await db.execute(sql`SELECT 1`);
    res.status(200).json({
      status: "healthy",
      database: "connected",
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("Database health check failed:", error);
    res.status(500).json({
      status: "unhealthy",
      database: "disconnected",
      timestamp: new Date().toISOString(),
    });
  }
});

// ─── 6. tRPC handler at /api/trpc ─────────────────────────────────────────────
app.use(
  "/api/trpc",
  trpcExpress.createExpressMiddleware({
    router: appRouter,
    createContext,
    onError({ path, error }) {
      logger.error(`Error in tRPC procedure [${path || "unknown"}]:`, error, "tRPC");
    },
  })
);

// ─── 7. Root info ─────────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.status(200).json({ message: "Gold Billing API", version: "1.0.0" });
});

// ─── 8. 404 handler ──────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ code: "NOT_FOUND", message: "Route not found." });
});

// ─── 9. Global error handler (must be last) ──────────────────────────────────
app.use(globalErrorHandler);

export default app;
