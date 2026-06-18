/**
 * Backfill script: assigns lot_ids to entries that are missing them.
 * Targets entries where:
 *   - lot_id IS NULL
 *   - The item is GOLD or ORNAMENT
 *   - The to_account is SHOP, GOLDSMITH, or CUSTOMER+GOLD_SMITH
 */
import { db } from "@/db";
import { entries, items as itemsTable, accounts as accountsTable } from "@/db/schema";
import { isNull, inArray } from "drizzle-orm";
import { generateLotId } from "@/lib/entryNoGenerator";

async function main() {
  // Find all entries with no lot_id
  const nullLotEntries = await db
    .select({
      id: entries.id,
      item_id: entries.item_id,
      to_account_id: entries.to_account_id,
      quantity: entries.quantity,
    })
    .from(entries)
    .where(isNull(entries.lot_id));

  if (nullLotEntries.length === 0) {
    console.log("No entries to backfill.");
    process.exit(0);
  }

  // Fetch item types
  const itemIds = [...new Set(nullLotEntries.map((e) => e.item_id))];
  const toAccountIds = [...new Set(nullLotEntries.map((e) => e.to_account_id))];

  const [itemTypes, accs] = await Promise.all([
    db.select({ id: itemsTable.id, type: itemsTable.type }).from(itemsTable).where(inArray(itemsTable.id, itemIds)),
    db.select({ id: accountsTable.id, type: accountsTable.type, customer_type: accountsTable.customer_type, name: accountsTable.name })
      .from(accountsTable)
      .where(inArray(accountsTable.id, toAccountIds)),
  ]);

  const itemTypeMap = new Map(itemTypes.map((i) => [i.id, i.type]));
  const accountMap = new Map(accs.map((a) => [a.id, a]));

  const toBackfill = nullLotEntries.filter((entry) => {
    const itemType = itemTypeMap.get(entry.item_id);
    const acc = accountMap.get(entry.to_account_id);
    if (!acc || !itemType) return false;
    const isGoldItem = itemType === "GOLD" || itemType === "ORNAMENT";
    const isGoldsmithAccount =
      acc.type === "SHOP" ||
      acc.type === "GOLDSMITH" ||
      (acc.type === "CUSTOMER" && acc.customer_type === "GOLD_SMITH");
    return isGoldItem && isGoldsmithAccount;
  });

  console.log(`Found ${toBackfill.length} entries to backfill.`);

  for (const entry of toBackfill) {
    const acc = accountMap.get(entry.to_account_id);
    await db.transaction(async (tx) => {
      const lotId = await generateLotId(tx);
      await tx.update(entries).set({ lot_id: lotId }).where(inArray(entries.id, [entry.id]));
      console.log(`Assigned ${lotId} to entry ${entry.id} (Account: ${acc?.name}, Quantity: ${entry.quantity})`);
    });
  }

  console.log("Done.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
