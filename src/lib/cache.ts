import { Table } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";

const fallbackTables = [
  "app_users",
  "user_form_permissions",
  "user_activity_permissions",
  "print_templates",
  "company_details",
  "tax_master",
  "refresh_tokens",
  "notifications",
  "items",
  "gst_sales_history",
  "gst_purchase_history",
  "entry_groups",
  "entries",
  "login_attempts",
  "accounts"
];

let schemaTables: string[] = [...fallbackTables];

/**
 * Register schema tables dynamically to detect SQL dependency tags.
 */
export function registerSchema(schema: any) {
  try {
    const tables = Object.values(schema)
      .filter((val): val is Table => val instanceof Table)
      .map((table) => getTableConfig(table).name);
    if (tables.length > 0) {
      schemaTables = Array.from(new Set([...fallbackTables, ...tables]));
    }
  } catch (err) {
    console.warn("Failed to dynamically register database schema tables for caching, using fallback list:", err);
  }
}

interface CacheEntry {
  value: any;
  expiresAt: number;
  tags: string[];
}

class MemoryCache {
  private cache = new Map<string, CacheEntry>();
  private defaultTtl = 300000; // Default TTL of 5 minutes in ms

  get(key: string): any | null {
    if (process.env.ENABLE_CACHE === "false") return null;
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    return entry.value;
  }

  set(key: string, value: any, tags: string[], ttlMs: number = this.defaultTtl): void {
    if (process.env.ENABLE_CACHE === "false") return;
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
      tags,
    });
  }

  invalidateTags(tags: string[]): void {
    if (process.env.ENABLE_CACHE === "false" || tags.length === 0) return;
    const tagSet = new Set(tags);
    for (const [key, entry] of this.cache.entries()) {
      if (entry.tags.some(tag => tagSet.has(tag))) {
        this.cache.delete(key);
      }
    }
  }

  clear(): void {
    this.cache.clear();
  }

  getStats() {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
    };
  }
}

export const memoryCache = new MemoryCache();

/**
 * Extracts schema table names mentioned in a SQL query.
 */
export function extractTables(sql: string): string[] {
  const tables = new Set<string>();
  const regex = /"([^"]+)"/g;
  let match;
  while ((match = regex.exec(sql)) !== null) {
    const word = match[1];
    if (word && schemaTables.includes(word)) {
      tables.add(word);
    }
  }
  return Array.from(tables);
}

/**
 * Determines whether a query is a read query.
 */
export function isReadQuery(sql: string): boolean {
  const trimmed = sql.trim().toUpperCase();
  return trimmed.startsWith("SELECT") || (trimmed.startsWith("WITH") && !/INSERT|UPDATE|DELETE/i.test(trimmed));
}

/**
 * Wraps a postgres connection or transaction client with caching logic.
 */
export function wrapSql(client: any, inTx = false, txTables = new Set<string>()): any {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "unsafe") {
        return function (query: string, params: any[] = [], options: any = {}) {
          const isRead = isReadQuery(query);
          const tables = extractTables(query);

          if (!isRead) {
            if (inTx) {
              // Mark tables for invalidation upon transaction commit
              tables.forEach(t => txTables.add(t));
            } else {
              // Direct write: invalidate tags immediately
              memoryCache.invalidateTags(tables);
            }
            return target.unsafe(query, params, options);
          }

          if (inTx) {
            // Transactions bypass cache reads to avoid stale updates
            return target.unsafe(query, params, options);
          }

          const cacheKey = JSON.stringify({ query, params });
          const cached = memoryCache.get(cacheKey);
          if (cached !== null) {
            return Promise.resolve(cached);
          }

          const pendingQuery = target.unsafe(query, params, options);
          return pendingQuery.then((result: any) => {
            memoryCache.set(cacheKey, result, tables);
            return result;
          });
        };
      }

      if (prop === "begin") {
        return function (...args: any[]) {
          const callbackIndex = args.findIndex(arg => typeof arg === "function");
          if (callbackIndex === -1) {
            return target.begin(...args);
          }

          const originalCallback = args[callbackIndex];
          const localTxTables = new Set<string>();

          args[callbackIndex] = async function (txClient: any) {
            const wrappedTxClient = wrapSql(txClient, true, localTxTables);
            try {
              const res = await originalCallback(wrappedTxClient);
              memoryCache.invalidateTags(Array.from(localTxTables));
              return res;
            } catch (err) {
              // Invalidate on rollback as well to be completely safe
              memoryCache.invalidateTags(Array.from(localTxTables));
              throw err;
            }
          };

          return target.begin(...args);
        };
      }

      const val = Reflect.get(target, prop, receiver);
      if (typeof val === "function") {
        return val.bind(target);
      }
      return val;
    }
  });
}
