import { db } from "../db";
import { entries, entryGroups, accounts, items } from "../db/schema";

async function dump() {
  try {
    const allEntries = await db.select().from(entries);
    const allGroups = await db.select().from(entryGroups);
    const allAccounts = await db.select().from(accounts);
    const allItems = await db.select().from(items);

    const groupMap = new Map(allGroups.map(g => [g.id, g]));
    const accountMap = new Map(allAccounts.map(a => [a.id, a]));
    const itemMap = new Map(allItems.map(i => [i.id, i]));

    console.log("=== ENTRIES IN THE SYSTEM ===");
    for (const e of allEntries) {
      const g = groupMap.get(e.group_id);
      const item = itemMap.get(e.item_id);
      const fromAcc = accountMap.get(e.from_account_id);
      const toAcc = accountMap.get(e.to_account_id);
      
      console.log(`- EntryID: ${e.id}, GroupType: ${g?.type}, GroupDeleted: ${g?.is_deleted}, From: "${fromAcc?.name}" (${fromAcc?.type}), To: "${toAcc?.name}" (${toAcc?.type}), Item: "${item?.name}" (${item?.type}), Qty: ${e.quantity}, PureQty: ${e.pure_quantity}`);
    }
    process.exit(0);
  } catch (err) {
    console.error("Error:", err);
    process.exit(1);
  }
}
dump();
