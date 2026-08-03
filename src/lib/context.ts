import * as trpcExpress from "@trpc/server/adapters/express";
import { verifyToken } from "@/config/jwt";

export interface Context {
  user: {
    id: string;
    username: string;
    user_group: string;
  } | null;
}

export function createContext({ req, res }: trpcExpress.CreateExpressContextOptions): Context {
  let token: string | undefined;

  // 1. Check HttpOnly cookie first
  if (req.cookies && (req.cookies.access_token || req.cookies.token)) {
    token = req.cookies.access_token || req.cookies.token;
  }
  // 2. Fallback to Authorization header if present
  else if (req.headers.authorization && req.headers.authorization.startsWith("Bearer ")) {
    token = req.headers.authorization.split(" ")[1];
  }

  if (!token) {
    return { user: null };
  }

  try {
    const decoded = verifyToken(token) as NonNullable<Context["user"]>;
    return { user: decoded };
  } catch (err) {
    return { user: null };
  }
}
