/**
 * Phase 4 Gate — Transaction modules validation
 * Run: bun run src/scripts/phase4-test.ts
 */
import { db } from "@/db";
import { items, appUsers } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { createItem } from "@/modules/items/service";
import { createAccount } from "@/modules/accounts/service";
import { createPurchase } from "@/modules/transactions/purchase/service";
import { createSale } from "@/modules/transactions/sales/service";
import { CreateSalesSchema } from "@/modules/transactions/sales/schema";
import { createExpense } from "@/modules/transactions/expense/service";
import { getBalance } from "@/lib/balance";
import { SYSTEM_ACCOUNTS, SYSTEM_ITEMS } from "@/config/constants";
import { AppError } from "@/types/errors";

function pass(label: string, detail?: string) {
  console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ""}`);
}
function fail(label: string, err?: unknown): never {
  console.error(`  ❌ FAIL: ${label}`);
  if (err) console.error("    ", err);
  process.exit(1);
}
function assert(ok: boolean, label: string, detail?: string) {
  if (!ok) fail(label, detail);
  pass(label, detail);
}

async function run() {
  const ts = Date.now();
  console.log("\n🧪 Phase 4 — Transaction Modules Gate\n");

  const [dbUser] = await db.select().from(appUsers).limit(1);
  if (!dbUser) {
    return fail("No user found. Run db:seed first.");
  }
  const creator = { id: dbUser.id, username: dbUser.username };

  // ── Setup: create gold item and supplier account ──────────────────────────
  const goldItem = await createItem({ name: `P4_Gold_${ts}`, type: "GOLD", unit: "GRAM" });
  const supplier = await createAccount({ name: `P4_Supplier_${ts}`, type: "CUSTOMER", customer_type: "PURCHASER", opening_pure_balance: "0", opening_cash_balance: "0" }, creator);
  const customer = await createAccount({ name: `P4_Customer_${ts}`, type: "CUSTOMER", customer_type: "CUSTOMER", opening_pure_balance: "0", opening_cash_balance: "0" }, creator);

  // ── Test 1: Purchase ─────────────────────────────────────────────────────
  console.log("📋 Test 1: transactions.purchase.create");
  let purchase: Awaited<ReturnType<typeof createPurchase>>;
  try {
    purchase = await createPurchase({
      account_id: supplier.id,
      date: "2026-03-24",
      rate_per_gram: "6000",
      gold_items: [{ item_id: goldItem.id, quantity: "200.00000000", purity: "91.60" }],
      ornament_items: [],
      bank_amount: "50000.00",
      discount: "1049200.00",
    });
  } catch (e) { return fail("createPurchase threw", e); }

  assert(!!purchase.group.id, "purchase group created");
  assert(purchase.group.type === "PURCHASE", "type = PURCHASE");
  assert(purchase.entries.length === 2, "2 entries: gold + money", `got ${purchase.entries.length}`);

  // SHOP should now have 200g of gold
  const shopGoldBalance = await getBalance(SYSTEM_ACCOUNTS.SHOP_ID, goldItem.id);
  assert(shopGoldBalance.toFixed(8) === "200.00000000", "SHOP gold balance = 200g after purchase", shopGoldBalance.toFixed(8));

  // Supplier should have received 50000 cash (negative — they received it from SHOP)
  const supplierCashBalance = await getBalance(supplier.id, SYSTEM_ITEMS.RUPEE_ITEM_ID);
  assert(supplierCashBalance.toFixed(2) === "50000.00", "Supplier cash balance correct", supplierCashBalance.toFixed(2));

  const purchasedGoldEntry = purchase.entries.find(e => e.item_id === goldItem.id);
  const lotId = purchasedGoldEntry?.lot_id;
  assert(!!lotId, "lotId is generated and retrieved");

  // ── Test 2: Sale — insufficient stock should fail ─────────────────────────
  console.log("\n📋 Test 2: transactions.sales.create — insufficient stock guard");
  try {
    await createSale(CreateSalesSchema.parse({
      account_id: customer.id,
      date: "2026-03-24",
      rate_per_gram: "6500",
      items: [{ item_id: goldItem.id, lot_id: lotId!, quantity: "999.00000000", purity: "91.60", wastage_mode: "GRAM", wastage_value: "0" }],
      bank_amount: "0",
    }), creator);
    fail("should have thrown BUSINESS_RULE_VIOLATION");
  } catch (e: any) {
    assert(e?.code === "BUSINESS_RULE_VIOLATION", "BUSINESS_RULE_VIOLATION on insufficient stock", e?.message);
  }

  // ── Test 3: Sale — within stock ───────────────────────────────────────────
  console.log("\n📋 Test 3: transactions.sales.create — within stock");
  let sale: Awaited<ReturnType<typeof createSale>>;
  try {
    sale = await createSale(CreateSalesSchema.parse({
      account_id: customer.id,
      date: "2026-03-24",
      rate_per_gram: "6500",
      items: [{ item_id: goldItem.id, lot_id: lotId!, quantity: "50.00000000", purity: "91.60", wastage_mode: "GRAM", wastage_value: "0.05" }],
      bank_amount: "10000.00",
    }), creator);
  } catch (e) { return fail("createSale threw", e); }

  // total dispatched = 50 + (50 × 0.05) = 50 + 2.5 = 52.5g
  // SHOP gold after sale = 200 - 52.5 = 147.5g
  assert(!!sale.group.id, "sale group created");
  assert(sale.group.type === "SALE", "type = SALE");

  const shopAfterSale = await getBalance(SYSTEM_ACCOUNTS.SHOP_ID, goldItem.id);
  assert(shopAfterSale.toFixed(8) === "147.50000000", "SHOP gold balance = 147.5g after sale (50g + 5% wastage)", shopAfterSale.toFixed(8));

  // ── Test 4: Expense ───────────────────────────────────────────────────────
  console.log("\n📋 Test 4: expense.create");
  let expense: Awaited<ReturnType<typeof createExpense>>;
  try {
    expense = await createExpense({ date: "2026-03-24", name: `P4_Rent_${ts}`, amount: "5000.00", reason: "Monthly rent" });
  } catch (e) { return fail("createExpense threw", e); }

  assert(!!expense.group.id, "expense group created");
  assert(expense.group.type === "EXPENSE", "type = EXPENSE");
  assert(expense.entries.length === 1, "1 entry: CASH → expense account");

  console.log("\n🎉 Phase 4 Gate — ALL TESTS PASSED\n");
  process.exit(0);
}

run().catch((e) => {
  console.error("❌ Unexpected:", e);
  process.exit(1);
});
