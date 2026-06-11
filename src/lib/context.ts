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
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { user: null };
  }

  const token = authHeader.split(" ")[1]!;
  try {
    const decoded = verifyToken(token) as NonNullable<Context["user"]>;
    return { user: decoded };
  } catch (err) {
    return { user: null };
  }
}
