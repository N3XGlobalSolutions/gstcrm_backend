/**
 * Phase 3 Gate — Items and Accounts module validation
 * Run from project root: bun run src/scripts/phase3-test.ts
 */
import { db } from "@/db";
import { accounts, entryGroups, entries, appUsers } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { createItem, deleteItem } from "@/modules/items/service";
import { createAccount, deleteAccount } from "@/modules/accounts/service";
import { getBalance } from "@/lib/balance";
import { SYSTEM_ACCOUNTS } from "@/config/constants";

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
  console.log("\n🧪 Phase 3 — Items & Accounts Gate\n");

  const [dbUser] = await db.select().from(appUsers).limit(1);
  if (!dbUser) {
    return fail("No user found. Run db:seed first.");
  }
  const creator = { id: dbUser.id, username: dbUser.username };

  // ── Test 1: Create a GOLD item ─────────────────────────────────────────────
  console.log("📋 Test 1: items.create");
  const ts = Date.now();
  let goldItem: Awaited<ReturnType<typeof createItem>>;
  try {
    goldItem = await createItem({ name: `TestGold_${ts}`, type: "GOLD", unit: "GRAM" });
  } catch (e) { return fail("createItem threw", e); }
  assert(!!goldItem.id, "gold item created");
  assert(goldItem.type === "GOLD", "type is GOLD");
  assert(typeof goldItem.entry_no === "number", "entry_no generated", String(goldItem.entry_no));

  // ── Test 2: Duplicate item should CONFLICT ─────────────────────────────────
  console.log("\n📋 Test 2: items.create duplicate → CONFLICT");
  try {
    await createItem({ name: "916 Hallmark Gold", type: "GOLD", unit: "GRAM" });
    fail("should have thrown CONFLICT");
  } catch (e: any) {
    assert(e?.code === "CONFLICT", "CONFLICT on duplicate item", e?.message);
  }

  // ── Test 3: Create a CUSTOMER account with opening balances ───────────────
  console.log("\n📋 Test 3: accounts.create with opening balances");
  let testAccount: Awaited<ReturnType<typeof createAccount>>;
  try {
    testAccount = await createAccount({
      name: "Phase3 Test Customer",
      type: "CUSTOMER",
      customer_type: "CUSTOMER",
      opening_pure_balance: "50.00000000",
      opening_cash_balance: "10000.00",
    }, creator);
  } catch (e) { return fail("createAccount threw", e); }
  assert(!!testAccount.id, "account created");

  // Verify 2 OPENING entry groups exist for this account
  const openingGroups = await db
    .select()
    .from(entryGroups)
    .where(and(eq(entryGroups.account_id, testAccount.id), eq(entryGroups.type, "OPENING")));
  assert(openingGroups.length === 2, "2 OPENING entry groups created", `found ${openingGroups.length}`);

  // Verify getBalance returns the opening values for RUPEE (used as proxy in Phase 3 seed)
  const { SYSTEM_ITEMS } = await import("@/config/constants");
  const pureBalance = await getBalance(testAccount.id, SYSTEM_ITEMS.RUPEE_ITEM_ID);
  // Both opening balances use RUPEE_ITEM_ID in Phase 3, so total = 50 + 10000
  assert(pureBalance.gt(0), "getBalance returns opening balance", pureBalance.toFixed(8));

  // ── Test 4: Delete item in use → BUSINESS_RULE_VIOLATION ──────────────────
  console.log("\n📋 Test 4: items.delete in-use → BUSINESS_RULE_VIOLATION");
  // The RUPEE_ITEM_ID is used in entries via opening balances above
  try {
    await deleteItem({ id: SYSTEM_ITEMS.RUPEE_ITEM_ID });
    fail("should have thrown BUSINESS_RULE_VIOLATION");
  } catch (e: any) {
    assert(
      e?.code === "BUSINESS_RULE_VIOLATION",
      "BUSINESS_RULE_VIOLATION on in-use item",
      e?.message,
    );
  }

  // ── Test 5: Delete system account → BUSINESS_RULE_VIOLATION ───────────────
  console.log("\n📋 Test 5: accounts.delete system account → BUSINESS_RULE_VIOLATION");
  try {
    await deleteAccount({ id: SYSTEM_ACCOUNTS.SHOP_ID }, creator);
    fail("should have thrown BUSINESS_RULE_VIOLATION");
  } catch (e: any) {
    assert(
      e?.code === "BUSINESS_RULE_VIOLATION",
      "BUSINESS_RULE_VIOLATION on system account delete",
      e?.message,
    );
  }

  // ── Test 6: Delete the test customer (has history → BUSINESS_RULE_VIOLATION)
  console.log("\n📋 Test 6: accounts.delete account with history → BUSINESS_RULE_VIOLATION");
  try {
    await deleteAccount({ id: testAccount.id }, creator);
    fail("should have thrown BUSINESS_RULE_VIOLATION");
  } catch (e: any) {
    assert(
      e?.code === "BUSINESS_RULE_VIOLATION",
      "BUSINESS_RULE_VIOLATION on account with tx history",
      e?.message,
    );
  }

  // ── Test 7: Delete the new gold item (not in use yet) ─────────────────────
  console.log("\n📋 Test 7: items.delete unused item → success");
  try {
    const result = await deleteItem({ id: goldItem.id });
    assert(result.success === true, "item deleted successfully");
  } catch (e) { return fail("deleteItem threw", e); }

  console.log("\n🎉 Phase 3 Gate — ALL TESTS PASSED\n");
  process.exit(0);
}

run().catch((e) => {
  console.error("❌ Unexpected:", e);
  process.exit(1);
});
