import { db } from "@/db";
import { entries, entryGroups, items, accounts } from "@/db/schema";
import { getLotBalances } from "@/lib/balance";
import { SYSTEM_ACCOUNTS } from "@/config/constants";
import { eq, and, desc, inArray } from "drizzle-orm";
import { sql } from "drizzle-orm";

async function diagnose() {
  console.log("🔍 DIAGNOSING MISSING STOCK ENTRIES\n");

  // Step 1: Find the 5 most recent PURCHASE entry groups
  const recentPurchases = await db
    .select()
    .from(entryGroups)
    .where(and(eq(entryGroups.type, "PURCHASE"), eq(entryGroups.is_deleted, false)))
    .orderBy(desc(entryGroups.created_at))
    .limit(5);

  console.log(`Found ${recentPurchases.length} recent purchase groups:`);
  for (const g of recentPurchases) {
    console.log(`  Entry#${g.entry_no} | Bill#${g.bill_no} | Date:${g.date} | GroupID:${g.id}`);
  }

  // Step 2: For each recent purchase, show all its entries
  console.log("\n📋 Entries for each recent purchase group:");
  for (const g of recentPurchases) {
    const groupEntries = await db
      .select({
        entry_id: entries.id,
        lot_id: entries.lot_id,
        from_account_id: entries.from_account_id,
        to_account_id: entries.to_account_id,
        item_id: entries.item_id,
        quantity: entries.quantity,
        purity: entries.purity,
        pure_quantity: entries.pure_quantity,
        item_name: items.name,
        item_type: items.type,
        to_account_name: accounts.name,
      })
      .from(entries)
      .leftJoin(items, eq(entries.item_id, items.id))
      .leftJoin(accounts, eq(entries.to_account_id, accounts.id))
      .where(eq(entries.group_id, g.id));

    console.log(`\n  --- Entry#${g.entry_no} (Group: ${g.id}) ---`);
    for (const e of groupEntries) {
      console.log(`    Item: ${e.item_name} (${e.item_type}) | Qty: ${e.quantity} | Purity: ${e.purity} | PureQty: ${e.pure_quantity}`);
      console.log(`    LotID: ${e.lot_id ?? "(NONE - no lot assigned!)"} | to_account: ${e.to_account_name} (${e.to_account_id})`);
      console.log(`    SHOP_ID match: ${e.to_account_id === SYSTEM_ACCOUNTS.SHOP_ID ? "✅ YES" : "❌ NO - MISMATCH!"}`);
    }
  }

  // Step 3: Check what SHOP_ID is configured as
  console.log(`\n🔧 System SHOP_ID constant: "${SYSTEM_ACCOUNTS.SHOP_ID}"`);
  const shopAccount = await db
    .select()
    .from(accounts)
    .where(eq(accounts.type, "SHOP"))
    .limit(1);
  console.log(`   Shop account in DB: ${shopAccount[0]?.id} (${shopAccount[0]?.name})`);
  const shopIdMatch = shopAccount[0]?.id === SYSTEM_ACCOUNTS.SHOP_ID;
  console.log(`   SHOP_ID matches DB: ${shopIdMatch ? "✅ YES" : "❌ NO - BIG PROBLEM!"}`);

  // Step 4: Check all gold/ornament items that exist
  const goldItems = await db
    .select()
    .from(items)
    .where(and(eq(items.type, "GOLD"), eq(items.is_deleted, false)));
  const ornamentItems = await db
    .select()
    .from(items)
    .where(and(eq(items.type, "ORNAMENT"), eq(items.is_deleted, false)));

  console.log(`\n📦 Gold items in DB: ${goldItems.map(i => i.name).join(", ")}`);
  console.log(`📦 Ornament items in DB: ${ornamentItems.map(i => i.name).join(", ")}`);

  // Step 5: Try getLotBalances for all items and show results
  console.log("\n📊 getLotBalances for all GOLD items at SHOP:");
  for (const item of goldItems) {
    const lots = await getLotBalances(SYSTEM_ACCOUNTS.SHOP_ID, item.id);
    if (lots.length > 0) {
      console.log(`  ${item.name}: ${lots.length} active lots`);
      for (const lot of lots.slice(-3)) { // show last 3 lots per item
        console.log(`    LOT: ${lot.lot_id} | Qty: ${lot.quantity} | Purity: ${lot.purity} | Pure: ${lot.pure_quantity} | Date: ${lot.created_at}`);
      }
    } else {
      console.log(`  ${item.name}: ⚠️  NO active lots`);
    }
  }

  // Step 6: Check if recent purchase entries have lot_id = NULL
  const recentGroupIds = recentPurchases.map(g => g.id);
  const nullLotEntries = await db
    .select({
      group_id: entries.group_id,
      item_id: entries.item_id,
      item_name: items.name,
      item_type: items.type,
      lot_id: entries.lot_id,
      to_account_id: entries.to_account_id,
      quantity: entries.quantity,
    })
    .from(entries)
    .leftJoin(items, eq(entries.item_id, items.id))
    .where(
      and(
        inArray(entries.group_id, recentGroupIds),
        sql`${entries.lot_id} IS NULL`,
      )
    );

  if (nullLotEntries.length > 0) {
    console.log("\n🚨 CRITICAL: Found entries with NULL lot_id in recent purchases:");
    for (const e of nullLotEntries) {
      console.log(`  GroupID: ${e.group_id} | Item: ${e.item_name} (${e.item_type}) | Qty: ${e.quantity} | to_account: ${e.to_account_id}`);
      console.log(`    → This entry should have a lot_id but it is NULL!`);
    }
  } else {
    console.log("\n✅ No NULL lot_id entries found in recent purchases.");
  }

  process.exit(0);
}

diagnose().catch((err) => {
  console.error("❌ Diagnostic failed:", err);
  process.exit(1);
});
