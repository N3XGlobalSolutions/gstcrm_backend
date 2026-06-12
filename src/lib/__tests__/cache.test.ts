import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { memoryCache, extractTables, isReadQuery, wrapSql } from "../cache";

describe("Caching System", () => {
  beforeEach(() => {
    memoryCache.clear();
    process.env.ENABLE_CACHE = "true";
  });

  afterEach(() => {
    process.env.ENABLE_CACHE = "true";
  });

  describe("isReadQuery", () => {
    it("identifies SELECT queries as read queries", () => {
      expect(isReadQuery('SELECT * FROM "items"')).toBe(true);
      expect(isReadQuery('   select id from "accounts" where x = 1')).toBe(true);
    });

    it("identifies WITH SELECT queries as read queries", () => {
      expect(isReadQuery('WITH CTE AS (SELECT id FROM "items") SELECT * FROM CTE')).toBe(true);
    });

    it("identifies INSERT, UPDATE, DELETE queries as non-read queries", () => {
      expect(isReadQuery('INSERT INTO "items" ("name") VALUES (\'Gold\')')).toBe(false);
      expect(isReadQuery('UPDATE "items" SET "name" = \'Gold\'')).toBe(false);
      expect(isReadQuery('DELETE FROM "items" WHERE id = 1')).toBe(false);
      expect(isReadQuery('ALTER TABLE "items" ADD COLUMN age int')).toBe(false);
    });

    it("identifies WITH INSERT/UPDATE queries as non-read queries", () => {
      expect(isReadQuery('WITH new_item AS (INSERT INTO "items" DEFAULT VALUES RETURNING id) SELECT * FROM new_item')).toBe(false);
    });
  });

  describe("extractTables", () => {
    it("extracts schema tables from double quotes", () => {
      const sql = 'SELECT * FROM "items" INNER JOIN "accounts" ON "items"."id" = "accounts"."id"';
      const tables = extractTables(sql);
      expect(tables).toContain("items");
      expect(tables).toContain("accounts");
      expect(tables).not.toContain("id"); // column name double quotes ignored since not in SCHEMA_TABLES
    });

    it("ignores double-quoted strings that are not schema tables", () => {
      const sql = 'SELECT "non_existent_table" FROM "items"';
      const tables = extractTables(sql);
      expect(tables).toEqual(["items"]);
    });
  });

  describe("MemoryCache Store", () => {
    it("can store and retrieve cached items", () => {
      memoryCache.set("key1", { data: "test" }, ["items"]);
      expect(memoryCache.get("key1")).toEqual({ data: "test" });
    });

    it("respects TTL expiration", async () => {
      memoryCache.set("key1", { data: "test" }, ["items"], 1); // 1 ms TTL
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(memoryCache.get("key1")).toBeNull();
    });

    it("respects ENABLE_CACHE=false", () => {
      process.env.ENABLE_CACHE = "false";
      memoryCache.set("key1", { data: "test" }, ["items"]);
      expect(memoryCache.get("key1")).toBeNull();
    });

    it("invalidates by tag", () => {
      memoryCache.set("key1", "val1", ["items"]);
      memoryCache.set("key2", "val2", ["accounts"]);
      memoryCache.set("key3", "val3", ["items", "accounts"]);

      memoryCache.invalidateTags(["items"]);

      expect(memoryCache.get("key1")).toBeNull();
      expect(memoryCache.get("key2")).toEqual("val2");
      expect(memoryCache.get("key3")).toBeNull();
    });
  });

  describe("wrapSql database proxy wrapper", () => {
    class MockClient {
      queriesExecuted: string[] = [];

      unsafe(query: string, params: any[] = [], options: any = {}) {
        this.queriesExecuted.push(query);
        if (query.includes("items")) {
          return Promise.resolve([{ id: "item-1" }]);
        }
        return Promise.resolve([{ id: "acc-1" }]);
      }

      async begin(callback: (tx: any) => Promise<any>) {
        const tx = new MockClient();
        return callback(tx);
      }
    }

    it("caches select queries and invalidates on write", async () => {
      const mock = new MockClient();
      const proxy = wrapSql(mock);

      // 1. SELECT query (miss)
      const res1 = await proxy.unsafe('SELECT * FROM "items" WHERE id = $1', [1]);
      expect(res1).toEqual([{ id: "item-1" }]);
      expect(mock.queriesExecuted).toHaveLength(1);

      // 2. SELECT query (hit)
      const res2 = await proxy.unsafe('SELECT * FROM "items" WHERE id = $1', [1]);
      expect(res2).toEqual([{ id: "item-1" }]);
      expect(mock.queriesExecuted).toHaveLength(1); // No new db executions

      // 3. INSERT query (invalidate)
      await proxy.unsafe('INSERT INTO "items" ("name") VALUES ($1)', ["test"]);
      expect(mock.queriesExecuted).toHaveLength(2);

      // 4. SELECT query (miss again)
      const res3 = await proxy.unsafe('SELECT * FROM "items" WHERE id = $1', [1]);
      expect(res3).toEqual([{ id: "item-1" }]);
      expect(mock.queriesExecuted).toHaveLength(3); // Query is executed on DB again
    });

    it("bypasses cache read in transactions and invalidates tags upon commit", async () => {
      const mock = new MockClient();
      const proxy = wrapSql(mock);

      // Populate some cache entries
      await proxy.unsafe('SELECT * FROM "items"');
      await proxy.unsafe('SELECT * FROM "accounts"');
      expect(memoryCache.getStats().size).toBe(2);

      // Run transaction
      await proxy.begin(async (tx: any) => {
        // Reads in transaction bypass cache read but still execute on DB
        await tx.unsafe('SELECT * FROM "items"');
        
        // Write query targets accounts table
        await tx.unsafe('UPDATE "accounts" SET "name" = $1', ["foo"]);
      });

      // After transaction commit, items cache should remain, but accounts cache should be invalidated
      expect(memoryCache.getStats().size).toBe(1);
      const cachedKeys = memoryCache.getStats().keys;
      expect(cachedKeys[0]).toContain("items");
      expect(cachedKeys[0]).not.toContain("accounts");
    });
  });
});
