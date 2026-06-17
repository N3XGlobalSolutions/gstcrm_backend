import dns from "dns";
import { env } from "@/config/env";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { registerSchema, wrapSql } from "@/lib/cache";

// Register the database schema tables for the cache detector
registerSchema(schema);

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
// We fall back to direct IP lookup via dns.resolve4 if lookup fails.
const neonHostname = getNeonHostname();
if (neonHostname && neonHostname.includes("neon.tech")) {
  const originalLookup = dns.lookup;
  // @ts-ignore
  dns.lookup = function (hostname: string, ...args: any[]) {
    if (hostname === neonHostname || hostname.includes("neon.tech")) {
      const callback = args[args.length - 1];
      // Try to resolve via Google's public DNS (8.8.8.8) by using dns.resolve4
      dns.resolve4(hostname, (err, addresses) => {
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
  max: 5,
  idle_timeout: 30,
  connect_timeout: 60,
  max_lifetime: 60 * 20,
});

// Wrap connection with caching proxy
const cachedConnection = wrapSql(connection);

// Create the Drizzle client with the full schema
export const db = drizzle(cachedConnection, { schema });

// Export schema for direct use in queries
export { schema };

export type Database = typeof db;
