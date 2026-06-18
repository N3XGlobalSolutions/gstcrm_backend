import { db } from "@/db";
import { entryGroups, entries, accounts, items } from "@/db/schema";
import { sql, eq, count } from "drizzle-orm";

async function run() {
  console.log("=== FULL DATABASE AUDIT ===\n");

  // 1. Count entry_groups by type
  const typeCounts = await db.execute<{ type: string; cnt: string; deleted_cnt: string }>(
    sql`SELECT type, 
        COUNT(*) AS cnt, 
        SUM(CASE WHEN is_deleted THEN 1 ELSE 0 END) AS deleted_cnt
        FROM entry_groups 
        GROUP BY type 
        ORDER BY type`
  );
  console.log("--- entry_groups by type ---");
  for (const r of typeCounts) {
    console.log(`  ${r.type}: ${r.cnt} total (${r.deleted_cnt} deleted)`);
  }

  // 2. Check for orphan entries (entries whose group_id doesn't exist)
  const orphans = await db.execute<{ cnt: string }>(
    sql`SELECT COUNT(*) AS cnt FROM entries e 
        LEFT JOIN entry_groups g ON e.group_id = g.id 
        WHERE g.id IS NULL`
  );
  console.log(`\n--- Orphan entries (no matching group): ${orphans[0]?.cnt} ---`);

  // 3. Check system accounts exist
  const sysAccounts = await db.execute<{ id: string; name: string; type: string }>(
    sql`SELECT id, name, type FROM accounts WHERE is_system_account = true ORDER BY name`
  );
  console.log("\n--- System accounts ---");
  for (const a of sysAccounts) {
    console.log(`  ${a.name} (${a.type}) -> ${a.id}`);
  }

  // 4. Check system item (RUPEE)
  const rupee = await db.execute<{ id: string; name: string; type: string }>(
    sql`SELECT id, name, type FROM items WHERE id = '00000000-0000-0000-0000-000000000010'`
  );
  console.log("\n--- System RUPEE item ---");
  console.log(`  Found: ${rupee.length > 0 ? `${rupee[0].name} (${rupee[0].type})` : "MISSING!"}`);

  // 5. Verify no PURCHASE records leak into SALE queries (the bug we fixed)
  const salesQuery = await db.execute<{ type: string; cnt: string }>(
    sql`SELECT type, COUNT(*) AS cnt 
        FROM entry_groups 
        WHERE is_deleted = false 
          AND (gst_amount IS NULL OR gst_amount = '0')
          AND type = 'SALE'
        GROUP BY type`
  );
  console.log("\n--- SALE records (unconverted, not deleted) ---");
  for (const r of salesQuery) {
    console.log(`  ${r.type}: ${r.cnt}`);
  }

  // 6. Verify no SALE records leak into PURCHASE queries
  const purchaseQuery = await db.execute<{ type: string; cnt: string }>(
    sql`SELECT type, COUNT(*) AS cnt 
        FROM entry_groups 
        WHERE is_deleted = false 
          AND (gst_amount IS NULL OR gst_amount = '0')
          AND type = 'PURCHASE'
        GROUP BY type`
  );
  console.log("\n--- PURCHASE records (unconverted, not deleted) ---");
  for (const r of purchaseQuery) {
    console.log(`  ${r.type}: ${r.cnt}`);
  }

  // 7. Cross-check: simulate the OLD buggy query to show what it would have returned
  const buggyQuery = await db.execute<{ type: string; cnt: string }>(
    sql`SELECT type, COUNT(*) AS cnt 
        FROM entry_groups 
        WHERE type = 'SALE' AND is_deleted = false AND gst_amount IS NULL OR gst_amount = '0'
        GROUP BY type`
  );
  console.log("\n--- OLD BUGGY QUERY (without parens) would return ---");
  for (const r of buggyQuery) {
    console.log(`  ${r.type}: ${r.cnt} ${r.type !== 'SALE' ? '<-- LEAK!' : ''}`);
  }

  // 8. Cross-check: simulate the FIXED query
  const fixedQuery = await db.execute<{ type: string; cnt: string }>(
    sql`SELECT type, COUNT(*) AS cnt 
        FROM entry_groups 
        WHERE type = 'SALE' AND is_deleted = false AND (gst_amount IS NULL OR gst_amount = '0')
        GROUP BY type`
  );
  console.log("\n--- FIXED QUERY (with parens) returns ---");
  for (const r of fixedQuery) {
    console.log(`  ${r.type}: ${r.cnt}`);
  }

  // 9. Count total entries
  const totalEntries = await db.execute<{ cnt: string }>(
    sql`SELECT COUNT(*) AS cnt FROM entries`
  );
  console.log(`\n--- Total ledger entries: ${totalEntries[0]?.cnt} ---`);

  // 10. GST history tables
  const gstSales = await db.execute<{ cnt: string }>(
    sql`SELECT COUNT(*) AS cnt FROM gst_sales_history`
  );
  const gstPurchases = await db.execute<{ cnt: string }>(
    sql`SELECT COUNT(*) AS cnt FROM gst_purchase_history`
  );
  console.log(`\n--- GST History ---`);
  console.log(`  GST Sales History rows: ${gstSales[0]?.cnt}`);
  console.log(`  GST Purchase History rows: ${gstPurchases[0]?.cnt}`);

  console.log("\n=== AUDIT COMPLETE ===");
  process.exit(0);
}

run().catch((err) => {
  console.error("Audit failed:", err);
  process.exit(1);
});
