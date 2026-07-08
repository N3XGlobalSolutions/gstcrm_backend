import { db } from "@/db";
import { accounts, items, entries, entryGroups } from "@/db/schema";
import { sql, or, and, gte, lt, ne, like } from "drizzle-orm";

async function cleanTestRecords() {
  console.log("🧹 Starting cleanup of test/mock records...");
  try {
    // 1. Find all mock accounts
    const mockAccountsResult = await db
      .select({ id: accounts.id, name: accounts.name })
      .from(accounts)
      .where(
        or(
          and(gte(accounts.entry_no, 500000), lt(accounts.entry_no, 1000000)),
          like(accounts.name, "Cust-%"),
          like(accounts.name, "Supp-%"),
          like(accounts.name, "Smith-%")
        )
      );

    const accountIds = mockAccountsResult.map(a => a.id).filter(id => {
      // Hard guard: never delete system accounts
      return ![
        "00000000-0000-0000-0000-000000000001",
        "00000000-0000-0000-0000-000000000002",
        "00000000-0000-0000-0000-000000000003",
        "00000000-0000-0000-0000-000000000004",
        "00000000-0000-0000-0000-000000000005",
        "00000000-0000-0000-0000-000000000006",
      ].includes(id);
    });

    if (accountIds.length > 0) {
      console.log(`Found ${accountIds.length} mock accounts. Cleaning up child records first...`);

      const idListStr = accountIds.map(id => `'${id}'`).join(',');
      
      // Delete entries referencing mock accounts or mock entry groups
      await db.execute(sql`
        DELETE FROM entries 
        WHERE from_account_id IN (${sql.raw(idListStr)})
        OR to_account_id IN (${sql.raw(idListStr)})
        OR group_id IN (
          SELECT id FROM entry_groups 
          WHERE account_id IN (${sql.raw(idListStr)})
        )
      `);

      // Delete from gst_sales_history
      await db.execute(sql`
        DELETE FROM gst_sales_history 
        WHERE account_id IN (${sql.raw(idListStr)})
      `);

      // Delete from gst_purchase_history
      await db.execute(sql`
        DELETE FROM gst_purchase_history 
        WHERE account_id IN (${sql.raw(idListStr)})
      `);

      // Delete from entry_groups
      await db.execute(sql`
        DELETE FROM entry_groups 
        WHERE account_id IN (${sql.raw(idListStr)})
      `);

      // Delete from labour_bill_cycles
      await db.execute(sql`
        DELETE FROM labour_bill_cycles 
        WHERE account_id IN (${sql.raw(idListStr)})
      `);

      // Delete mock accounts themselves
      await db.execute(sql`
        DELETE FROM accounts 
        WHERE id IN (${sql.raw(idListStr)})
      `);

      console.log(`✅ Cleaned up ${accountIds.length} mock accounts and their children.`);
    } else {
      console.log("No mock accounts found.");
    }

    // 2. Find and delete mock items (Pure Gold-%, Ornament-%, entry_no >= 500000 but < 1000000)
    const mockItemsResult = await db
      .select({ id: items.id, name: items.name })
      .from(items)
      .where(
        and(
          ne(items.type, "MONEY"),
          or(
            and(gte(items.entry_no, 500000), lt(items.entry_no, 1000000)),
            like(items.name, "Pure Gold-%"),
            like(items.name, "Ornament-%")
          )
        )
      );

    const itemIds = mockItemsResult.map(i => i.id);
    if (itemIds.length > 0) {
      console.log(`Found ${itemIds.length} mock items. Cleaning up associated transaction entries...`);
      
      const itemIdListStr = itemIds.map(id => `'${id}'`).join(',');
      
      await db.execute(sql`
        DELETE FROM entries 
        WHERE item_id IN (${sql.raw(itemIdListStr)})
      `);

      await db.execute(sql`
        DELETE FROM items 
        WHERE id IN (${sql.raw(itemIdListStr)})
      `);

      console.log(`✅ Cleaned up ${itemIds.length} mock items.`);
    } else {
      console.log("No mock items found.");
    }

    console.log("✨ Cleanup completed successfully!");
    process.exit(0);
  } catch (err) {
    console.error("❌ Error during cleanup:", err);
    process.exit(1);
  }
}

cleanTestRecords();
