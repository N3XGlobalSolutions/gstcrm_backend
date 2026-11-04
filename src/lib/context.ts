import * as trpcExpress from "@trpc/server/adapters/express";
import { verifyToken } from "@/config/jwt";
import { AUDIT_REASON_HEADER, parseAuditReasonHeader } from "@/modules/audit/reason";

export interface ContextUser {
  id: string;
  username: string;
  user_group: string;
  // Device claim (user_devices.id) — absent on tokens issued before it existed.
  did?: string | null;
}

export interface Context {
  user: ContextUser | null;
  // Request metadata for the activity / audit logs.
  ip?: string | null;
  userAgent?: string | null;
  // "Why are you changing this bill?" — x-audit-reason header (encodeURIComponent'd),
  // 3–500 characters after decoding, else null. See src/modules/audit/reason.ts.
  auditReason?: string | null;
}

export function createContext({ req, res }: trpcExpress.CreateExpressContextOptions): Context {
  const meta = {
    ip: (req.ip ?? req.socket?.remoteAddress ?? null) as string | null,
    userAgent: (req.headers["user-agent"] ?? null) as string | null,
    auditReason: parseAuditReasonHeader(req.headers[AUDIT_REASON_HEADER]),
  };

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
    return { user: null, ...meta };
  }

  try {
    const decoded = verifyToken(token);
    const user: ContextUser = {
      id: decoded.id,
      username: decoded.username,
      user_group: decoded.user_group,
      ...(decoded.did !== undefined ? { did: decoded.did } : {}),
    };
    return { user, ...meta };
  } catch (err) {
    return { user: null, ...meta };
  }
}
