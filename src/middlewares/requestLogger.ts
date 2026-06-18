import type { Request, Response, NextFunction } from "express";
import { logger } from "@/lib/logger";

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const url = req.originalUrl || req.url;

  // 1. Exclude health checks
  if (url === "/api/health" || url === "/api/health3") {
    return next();
  }

  // 2. Exclude static assets (js, css, images, map, etc.)
  if (
    url.match(/\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|map)$/) ||
    url.startsWith("/assets/")
  ) {
    return next();
  }

  // 3. Handle tRPC and polling request parsing
  let label = url;
  let type = "HTTP";

  if (url.startsWith("/api/trpc/")) {
    const parts = url.split("/api/trpc/");
    const procedures = parts[1]?.split("?")?.[0] || "";
    if (procedures) {
      // Exclude polling requests
      if (
        procedures.includes("notifications.getUnreadCount") ||
        procedures.includes("dashboard.getNotifications")
      ) {
        return next();
      }
      label = procedures;
      type = "tRPC";
    }
  }

  const start = Date.now();

  res.on("finish", () => {
    const duration = Date.now() - start;
    const status = res.statusCode;

    logger.logRequest({
      type,
      method: req.method,
      url: label,
      status,
      duration,
    });
  });

  next();
}
