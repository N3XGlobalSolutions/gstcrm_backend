/**
 * Phase 2 — Ledger Core Validation Script
 *
 * Tests all three core ledger functions in isolation:
 *   1. createEntryGroup  — writes entries atomically
 *   2. getBalance        — reads correct net from entries
 *   3. reverseEntryGroup — swaps from/to, returns balance to zero
 *
 * Run with: bun run /tmp/ledger-test.ts
 */

import { db } from "@/db";
import { accounts, items } from "@/db/schema";
import { SYSTEM_ACCOUNTS, SYSTEM_ITEMS } from "@/config/constants";
import { createEntryGroup } from "@/lib/entryBuilder";
import { getBalance } from "@/lib/balance";
import { reverseEntryGroup } from "@/lib/reversal";
import { and, eq } from "drizzle-orm";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pass(label: string, detail?: string) {
  console.log(`  ✅ PASS: ${label}${detail ? ` — ${detail}` : ""}`);
}

function fail(label: string, err: unknown) {
  console.error(`  ❌ FAIL: ${label}`);
  console.error("     ", err);
  process.exit(1);
}

function assert(condition: boolean, label: string, detail?: string) {
  if (!condition) {
    console.error(`  ❌ ASSERT FAILED: ${label}${detail ? ` — ${detail}` : ""}`);
    process.exit(1);
  }
  pass(label, detail);
}

// ─── Setup: Get a real item to use in test entries ────────────────────────────

async function getFirstGoldItem() {
  const [item] = await db
    .select()
    .from(items)
    .where(and(eq(items.type, "GOLD"), eq(items.is_deleted, false)))
    .limit(1);
  return item ?? null;
}

async function getFirstCustomerAccount() {
  const [account] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.type, "CUSTOMER"), eq(accounts.is_deleted, false)))
    .limit(1);
  return account ?? null;
}

// ─── Main test ────────────────────────────────────────────────────────────────

async function runLedgerTest() {
  console.log("\n🧪 Phase 2 — Ledger Core Validation\n");

  // ── Determine test item: prefer first GOLD item, fall back to RUPEE ──────
  let testItemId: string;
  let testItemName: string;

  const goldItem = await getFirstGoldItem();
  if (goldItem) {
    testItemId = goldItem.id;
    testItemName = goldItem.name;
    console.log(`  ℹ️  Using gold item: ${testItemName} (${testItemId})`);
  } else {
    // No gold items seeded yet — use RUPEE (always seeded)
    testItemId = SYSTEM_ITEMS.RUPEE_ITEM_ID;
    testItemName = "Rupee";
    console.log(`  ℹ️  No gold items found — using RUPEE item for test`);
  }

  // ── Determine test accounts ────────────────────────────────────────────────
  const fromAccountId = SYSTEM_ACCOUNTS.SHOP_ID;   // SHOP sends
  const toAccountId   = SYSTEM_ACCOUNTS.CASH_ID;   // CASH receives

  console.log(`  ℹ️  From account: SHOP  (${fromAccountId})`);
  console.log(`  ℹ️  To   account: CASH  (${toAccountId})`);

  // ── Record balances BEFORE ─────────────────────────────────────────────────
  const shopBefore = await getBalance(fromAccountId, testItemId);
  const cashBefore = await getBalance(toAccountId,   testItemId);
  console.log(`\n  ℹ️  Before — SHOP balance: ${shopBefore.toFixed(8)}`);
  console.log(`  ℹ️  Before — CASH balance: ${cashBefore.toFixed(8)}`);

  // ── TEST 1: createEntryGroup ───────────────────────────────────────────────
  console.log("\n📋 Test 1: createEntryGroup");

  const testQuantity = "100.00000000";

  let group: Awaited<ReturnType<typeof createEntryGroup>>["group"];
  let createdEntries: Awaited<ReturnType<typeof createEntryGroup>>["entries"];

  try {
    const result = await createEntryGroup({
      type: "PURCHASE",
      accountId: fromAccountId,
      date: "2026-03-24",
      ratePerGram: "6000.00",
      remarks: "Phase 2 ledger test",
      entries: [
        {
          fromAccountId,
          toAccountId,
          itemId: testItemId,
          quantity: testQuantity,
          purity: "91.60",
        },
      ],
    });
    group = result.group;
    createdEntries = result.entries;
  } catch (err) {
    return fail("createEntryGroup threw an error", err);
  }

  assert(!!group, "group row returned", `id=${group.id}`);
  assert(typeof group.entry_no === "number", "group.entry_no is a number", String(group.entry_no));
  assert(createdEntries.length === 1, "exactly 1 entry inserted");

  const entry = createdEntries[0]!;
  assert(entry.group_id === group.id, "entry.group_id links to group");
  assert(entry.from_account_id === fromAccountId, "from_account_id correct");
  assert(entry.to_account_id   === toAccountId,   "to_account_id correct");
  assert(entry.quantity === testQuantity, "quantity stored correctly", entry.quantity);
  // pure_quantity = 100 × (91.6/100) = 91.6
  assert(
    entry.pure_quantity !== null && parseFloat(entry.pure_quantity) > 0,
    "pure_quantity computed and stored",
    entry.pure_quantity ?? "null",
  );

  // ── TEST 2: getBalance ─────────────────────────────────────────────────────
  console.log("\n📋 Test 2: getBalance");

  const shopAfterCreate = await getBalance(fromAccountId, testItemId);
  const cashAfterCreate = await getBalance(toAccountId,   testItemId);

  console.log(`  ℹ️  After create — SHOP balance: ${shopAfterCreate.toFixed(8)}`);
  console.log(`  ℹ️  After create — CASH balance: ${cashAfterCreate.toFixed(8)}`);

  const expectedShopDelta = shopBefore.minus(testQuantity);
  const expectedCashDelta = cashBefore.plus(testQuantity);

  assert(
    shopAfterCreate.toFixed(8) === expectedShopDelta.toFixed(8),
    "SHOP balance decreased by quantity",
    `${shopBefore.toFixed(2)} → ${shopAfterCreate.toFixed(2)}`,
  );
  assert(
    cashAfterCreate.toFixed(8) === expectedCashDelta.toFixed(8),
    "CASH balance increased by quantity",
    `${cashBefore.toFixed(2)} → ${cashAfterCreate.toFixed(2)}`,
  );

  // ── TEST 3: reverseEntryGroup ──────────────────────────────────────────────
  console.log("\n📋 Test 3: reverseEntryGroup");

  let reversalGroup: Awaited<ReturnType<typeof reverseEntryGroup>>;
  try {
    reversalGroup = await reverseEntryGroup(group.id);
  } catch (err) {
    return fail("reverseEntryGroup threw an error", err);
  }

  assert(!!reversalGroup, "reversal group returned", `id=${reversalGroup.id}`);
  assert(reversalGroup.type === "REVERSAL", "reversal group type is REVERSAL");
  assert(reversalGroup.reversal_of === group.id, "reversal_of links to original");

  // Balance should be back to BEFORE values
  const shopAfterReversal = await getBalance(fromAccountId, testItemId);
  const cashAfterReversal = await getBalance(toAccountId,   testItemId);

  console.log(`  ℹ️  After reversal — SHOP balance: ${shopAfterReversal.toFixed(8)}`);
  console.log(`  ℹ️  After reversal — CASH balance: ${cashAfterReversal.toFixed(8)}`);

  assert(
    shopAfterReversal.toFixed(8) === shopBefore.toFixed(8),
    "SHOP balance restored to pre-transaction value",
  );
  assert(
    cashAfterReversal.toFixed(8) === cashBefore.toFixed(8),
    "CASH balance restored to pre-transaction value",
  );

  // Guard: calling reverseEntryGroup again on the same id should throw CONFLICT
  console.log("\n📋 Test 4: double-reversal guard");
  try {
    await reverseEntryGroup(group.id);
    fail("should have thrown CONFLICT on double-reversal", "no error thrown");
  } catch (err: any) {
    assert(
      err?.code === "CONFLICT" || err?.message?.includes("already reversed"),
      "CONFLICT thrown on double reversal",
      err?.message,
    );
  }

  // ── All done ───────────────────────────────────────────────────────────────
  console.log("\n🎉 Phase 2 Gate — ALL TESTS PASSED\n");
  process.exit(0);
}

runLedgerTest().catch((err) => {
  console.error("❌ Unexpected error:", err);
  process.exit(1);
});
