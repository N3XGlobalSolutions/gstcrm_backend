import dns from "dns";

// Override dns.lookup to bypass DNS query refusal from the local DNS server for the Neon DB host
const originalLookup = dns.lookup;
// @ts-ignore
dns.lookup = function (hostname: string, ...args: any[]) {
  if (hostname === "ep-fragrant-salad-a1ctyy6p.ap-southeast-1.aws.neon.tech") {
    const callback = args[args.length - 1];
    const options = args[0] !== callback ? args[0] : {};
    const opts = typeof options === "object" && options !== null ? options : {};
    if (opts.all) {
      return callback(null, [{ address: "52.220.170.93", family: 4 }]);
    }
    return callback(null, "52.220.170.93", 4);
  }
  // @ts-ignore
  return originalLookup.apply(dns, [hostname, ...args]);
} as any;

import { env } from "@/config/env";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { registerSchema, wrapSql } from "@/lib/cache";

// Register the database schema tables for the cache detector
registerSchema(schema);

// Create the postgres.js connection pool.
// `connect_timeout` raised to absorb Neon scale-to-zero cold starts (5–15s).
// `max_lifetime` recycles sockets that Neon may have closed during inactivity.
const connection = postgres(env.DATABASE_URL, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 30,
  max_lifetime: 60 * 30,
});

// Wrap connection with caching proxy
const cachedConnection = wrapSql(connection);

// Create the Drizzle client with the full schema
export const db = drizzle(cachedConnection, { schema });

// Export schema for direct use in queries
export { schema };

export type Database = typeof db;
