import type { Request, Response, NextFunction } from "express";
import { verifyToken } from "@/config/jwt";

export function authMiddleware(
  req: Request & {
    appUser?: { id: string; username: string; user_group: string } | null;
  },
  res: Response,
  next: NextFunction,
): void {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ message: "Unauthorized. Token missing." });
      return;
    }

    const token = authHeader.split(" ")[1]!;
    const decoded = verifyToken(token);
    
    req.appUser = {
      id: decoded.id,
      username: decoded.username,
      user_group: decoded.user_group,
    };
  } catch (error) {
    res.status(401).json({ message: "Unauthorized. Invalid or expired token." });
    return;
  }

  next();
}
