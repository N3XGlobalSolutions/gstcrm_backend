import type { Request, Response, NextFunction } from "express";
import { AppError, ErrorHttpStatus } from "@/types/errors";
import { env } from "@/config/env";
import { logger } from "@/lib/logger";

/**
 * Global Express error handler — must be registered as the LAST middleware in app.ts.
 * Maps AppError codes to HTTP status codes and suppresses stack traces in production.
 */
export function globalErrorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    const status = ErrorHttpStatus[err.code] ?? 500;
    res.status(status).json({
      code: err.code,
      message: err.message,
      ...(err.field ? { field: err.field } : {}),
    });
    return;
  }

  // Log unexpected errors
  logger.error("Unhandled server error", err, "EXPRESS");

  const message = env.IS_PROD
    ? "An internal server error occurred."
    : String(err);
  res.status(500).json({
    code: "INTERNAL_ERROR",
    message,
  });
}
