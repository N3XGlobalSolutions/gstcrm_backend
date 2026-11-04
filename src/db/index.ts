import dns from "dns";
import { env } from "@/config/env";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { sql } from "drizzle-orm";
import { getAuditContext, auditSettingValues } from "@/modules/audit/context";

// Extract the hostname from DATABASE_URL for the DNS override
function getNeonHostname(): string | null {
  try {
    const url = new URL(env.DATABASE_URL);
    return url.hostname;
  } catch {
    return null;
  }
}

// Override dns.lookup to bypass local DNS resolution failures for Neon endpoints.
// Neon uses AWS DNS which may be blocked by some ISP/corporate resolvers.
// We fall back to direct IP lookup via Google DNS (8.8.8.8) using dns.Resolver if lookup fails.
const neonHostname = getNeonHostname();
if (neonHostname && neonHostname.includes("neon.tech")) {
  const originalLookup = dns.lookup;
  const resolver = new dns.Resolver();
  try {
    resolver.setServers(["8.8.8.8", "8.8.4.4"]);
  } catch (e) {
    console.warn("Failed to set custom DNS servers for resolver, falling back to default resolver:", e);
  }

  // @ts-ignore
  dns.lookup = function (hostname: string, ...args: any[]) {
    if (hostname === neonHostname || hostname.includes("neon.tech")) {
      const callback = args[args.length - 1];
      resolver.resolve4(hostname, (err, addresses) => {
        if (err || !addresses || addresses.length === 0) {
          // Fall back to original lookup if resolve4 also fails
          // @ts-ignore
          return originalLookup.apply(dns, [hostname, ...args]);
        }
        const opts = args[0] !== callback && typeof args[0] === "object" ? args[0] : {};
        if (opts.all) {
          return callback(null, addresses.map(a => ({ address: a, family: 4 })));
        }
        return callback(null, addresses[0], 4);
      });
    } else {
      // @ts-ignore
      return originalLookup.apply(dns, [hostname, ...args]);
    }
  } as any;
}

// Create the postgres.js connection pool.
// `connect_timeout` raised to absorb Neon scale-to-zero cold starts (up to 30s).
// `max_lifetime` recycles sockets that Neon may close during inactivity.
// `idle_timeout` keeps connections alive between requests.
const connection = postgres(env.DATABASE_URL, {
  max: 15,
  idle_timeout: 30,
  connect_timeout: 60,
  max_lifetime: 60 * 20,
});

// Create the Drizzle client with the full schema
export const db = drizzle(connection, { schema });

// ─── Data audit: stamp the actor on every transaction ─────────────────────────
// The gstcrm_audit_row() trigger (migration 0025) reads gstcrm.user_id /
// username / ip / path / reason to record who made each change. When the request
// runs inside runWithAuditContext (protectedProcedure), the first statement of
// every top-level transaction copies that actor into TRANSACTION-LOCAL settings
// (set_config(..., true)) — the only form safe behind Neon's transaction-mode
// pooler. Nested tx.transaction() savepoints are untouched (same transaction).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const rawTransaction = db.transaction.bind(db);
db.transaction = ((fn: Parameters<typeof rawTransaction>[0], config?: Parameters<typeof rawTransaction>[1]) => {
  // Read the actor now, in the caller's async context (not inside the driver's callback).
  const store = getAuditContext();
  return rawTransaction(async (tx) => {
    if (store) {
      const v = auditSettingValues(store);
      const userId = UUID_RE.test(v.userId) ? v.userId : "";
      await tx.execute(
        sql`select set_config('gstcrm.user_id', ${userId}, true), set_config('gstcrm.username', ${v.username}, true), set_config('gstcrm.ip', ${v.ip}, true), set_config('gstcrm.path', ${v.path}, true), set_config('gstcrm.reason', ${v.reason}, true)`,
      );
    }
    return fn(tx);
  }, config);
}) as typeof db.transaction;

// Export schema for direct use in queries
export { schema };

export type Database = typeof db;
