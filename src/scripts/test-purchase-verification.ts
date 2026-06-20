import { db } from "@/db";
import { items, appUsers, accounts, entryGroups, entries } from "@/db/schema";
import { createItem } from "@/modules/items/service";
import { createAccount } from "@/modules/accounts/service";
import { createPurchase } from "@/modules/transactions/purchase/service";
import { getLotBalances } from "@/lib/balance";
import { SYSTEM_ACCOUNTS } from "@/config/constants";
import { reverseEntryGroup } from "@/lib/reversal";
import { eq } from "drizzle-orm";

async function run() {
  console.log("🧪 STARTING E2E PURCHASE & STOCK FLOW VERIFICATION SCRIPT\n");

  // Step 0: Get a creator user for seed/setup
  const [dbUser] = await db.select().from(appUsers).limit(1);
  if (!dbUser) {
    console.error("❌ Error: No user found. Please run the seed command first.");
    process.exit(1);
  }
  const creator = { id: dbUser.id, username: dbUser.username };

  const ts = Date.now();
  const goldItem = await createItem({
    name: `Test_Gold_Lot_${ts}`,
    type: "GOLD",
    unit: "GRAM"
  });
  console.log(`✅ Created test gold item: "${goldItem.name}" (ID: ${goldItem.id})`);

  const supplier = await createAccount({
    name: `Test_Supplier_Lot_${ts}`,
    type: "CUSTOMER",
    customer_type: "PURCHASER",
    opening_pure_balance: "0",
    opening_cash_balance: "0"
  }, creator);
  console.log(`✅ Created test supplier: "${supplier.name}" (ID: ${supplier.id})`);

  // Step 1: Verify settle-to-zero enforcement
  console.log("\n1️⃣  Testing settle-to-zero validation...");
  
  // Math: 10g weight, 99.00% touch = 9.9g pure weight.
  // 9.9g pure * 5000 rate = 49500 cash value.
  // We pay 40000. Balance of 9500 remains, which is NOT settled.
  try {
    await createPurchase({
      account_id: supplier.id,
      date: "2026-06-20",
      rate_per_gram: "5000",
      gold_items: [{ item_id: goldItem.id, quantity: "10.000", purity: "99.00" }],
      ornament_items: [],
      bank_amount: "40000.00",
      discount: "0.00",
    });
    console.error("❌ Fail: Allowed purchase transaction to save without settling balance to zero!");
    process.exit(1);
  } catch (error: any) {
    if (error.message && error.message.includes("must be fully settled")) {
      console.log("✅ Success: Settle-to-zero validation triggered correctly! Error message:", error.message);
    } else {
      console.error("❌ Fail: Unexpected error thrown during settle-to-zero test:", error);
      process.exit(1);
    }
  }

  // Step 2: Create a purchase that is fully settled (Bank Paid = Cash Value)
  console.log("\n2️⃣  Creating a fully-settled purchase...");
  const purchase = await createPurchase({
    account_id: supplier.id,
    date: "2026-06-20",
    rate_per_gram: "5000",
    gold_items: [{ item_id: goldItem.id, quantity: "10.000", purity: "99.00" }],
    ornament_items: [],
    bank_amount: "49500.00", // Exactly settles 9.9g * 5000
    discount: "0.00",
  });
  console.log(`✅ Success: Purchase created with group ID: ${purchase.group.id}`);

  // Step 3: Verify the stock entries and generated lot ID
  console.log("\n3️⃣  Verifying stock entry and lot ID generation...");
  const purchaseEntries = await db
    .select()
    .from(entries)
    .where(eq(entries.group_id, purchase.group.id));

  const goldEntry = purchaseEntries.find(e => e.item_id === goldItem.id);
  if (!goldEntry) {
    console.error("❌ Fail: Gold stock entry not found in the transaction entries!");
    process.exit(1);
  }

  const generatedLotId = goldEntry.lot_id;
  if (!generatedLotId || !generatedLotId.startsWith("LOT-")) {
    console.error(`❌ Fail: Lot ID was not generated correctly! Found: "${generatedLotId}"`);
    process.exit(1);
  }
  console.log(`✅ Success: Generated Lot ID: "${generatedLotId}" for purchase gold entry.`);

  // Step 4: Verify stock is visible and correct in ledger balances (getLotBalances)
  console.log("\n4️⃣  Checking stock visibility in getLotBalances (Shop Stock)...");
  const shopLots = await getLotBalances(SYSTEM_ACCOUNTS.SHOP_ID, goldItem.id);
  
  const ourLot = shopLots.find(lot => lot.lot_id === generatedLotId);
  if (!ourLot) {
    console.error(`❌ Fail: Lot "${generatedLotId}" is NOT visible in Shop stock!`);
    process.exit(1);
  }

  const netQty = parseFloat(ourLot.quantity.toString());
  const purity = parseFloat(ourLot.purity?.toString() || "0");
  const pureQty = parseFloat(ourLot.pure_quantity?.toString() || "0");

  if (netQty !== 10 || purity !== 99 || pureQty !== 9.9) {
    console.error(`❌ Fail: Lot quantities do not match! Expected Qty=10, Purity=99, Pure=9.9. Found Qty=${netQty}, Purity=${purity}, Pure=${pureQty}`);
    process.exit(1);
  }
  console.log(`✅ Success: Lot is fully visible in getLotBalances with correct values:
     Weight: ${netQty.toFixed(3)}g
     Touch : ${purity.toFixed(2)}%
     Pure  : ${pureQty.toFixed(3)}g`);

  // Step 5: Verify Reversal / Cleanup handles stock reduction correctly
  console.log("\n5️⃣  Testing purchase transaction reversal...");
  await reverseEntryGroup(purchase.group.id);
  console.log("✅ Success: Purchase transaction reversed.");

  // Check shop stock again, lot should be removed/fully-consumed (net balance <= 0)
  const shopLotsPostReversal = await getLotBalances(SYSTEM_ACCOUNTS.SHOP_ID, goldItem.id);
  const ourLotPostReversal = shopLotsPostReversal.find(lot => lot.lot_id === generatedLotId);
  
  if (ourLotPostReversal) {
    console.error(`❌ Fail: Reversed Lot "${generatedLotId}" is still returned in getLotBalances!`);
    process.exit(1);
  }
  console.log(`✅ Success: Lot "${generatedLotId}" successfully cleared/consumed from active stock list after reversal.`);

  console.log("\n🎉 ALL TESTS PASSED SUCCESSFULLY! The purchase flow, calculation engine, dynamic lot-id generation, stock ledger visibility, and reversal flows are 100% correct.\n");
  process.exit(0);
}

run().catch((err) => {
  console.error("❌ Test failed with unhandled error:", err);
  process.exit(1);
});
