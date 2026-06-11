import "@/config/env"; // Must be first import — validates env at startup
import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import morgan from "morgan";
import * as trpcExpress from "@trpc/server/adapters/express";
import { createContext } from "@/lib/context";
import { appRouter } from "@/app.router";
import authRouter from "@/modules/auth/router";
import { globalErrorHandler } from "@/middlewares/errorHandler";
import { env } from "@/config/env";

const app = express();

// Use morgan for HTTP request logging
app.use(morgan("dev"));

// Trust first proxy so rate-limiter reads the real client IP from X-Forwarded-For
app.set("trust proxy", 1);

// ─── 1. Security headers ──────────────────────────────────────────────────────
app.use(helmet());

// ─── 2. CORS ──────────────────────────────────────────────────────────────────
const allowedOrigins = [env.FRONTEND_URL, "http://localhost:5173", "http://localhost:5174"];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like same-origin requests)
      if (!origin) return callback(null, true);
      
      // In development, dynamically allow any localhost origin
      if (env.NODE_ENV === "development" && (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:"))) {
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
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

// ─── 6. tRPC handler at /api/trpc ─────────────────────────────────────────────
app.use(
  "/api/trpc",
  trpcExpress.createExpressMiddleware({
    router: appRouter,
    createContext,
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
