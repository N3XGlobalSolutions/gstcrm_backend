import type { Request, Response, NextFunction } from "express";
import { verifyToken } from "@/config/jwt";

export function authMiddleware(
  req: Request & {
    appUser?: { id: string; username: string; user_group: string } | null;
    cookies?: Record<string, string>;
  },
  res: Response,
  next: NextFunction,
): void {
  try {
    let token: string | undefined;

    if (req.cookies && (req.cookies.access_token || req.cookies.token)) {
      token = req.cookies.access_token || req.cookies.token;
    } else if (req.headers.authorization && req.headers.authorization.startsWith("Bearer ")) {
      token = req.headers.authorization.split(" ")[1];
    }

    if (!token) {
      res.status(401).json({ message: "Unauthorized. Token missing." });
      return;
    }

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
