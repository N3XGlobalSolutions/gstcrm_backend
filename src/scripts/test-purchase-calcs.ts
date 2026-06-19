import { db } from "@/db";
import { items, appUsers } from "@/db/schema";
import { createItem } from "@/modules/items/service";
import { createAccount, getAccountAggregateBalances } from "@/modules/accounts/service";
import { createPurchase, listPurchases } from "@/modules/transactions/purchase/service";
import { getBalance, getAggregateBalances } from "@/lib/balance";
import { SYSTEM_ACCOUNTS, SYSTEM_ITEMS } from "@/config/constants";

async function run() {
  console.log("🧪 RUNNING PURCHASE CALCULATION TEST FLOW\n");

  const [dbUser] = await db.select().from(appUsers).limit(1);
  if (!dbUser) {
    console.error("❌ No user found. Seed the DB first.");
    process.exit(1);
  }
  const creator = { id: dbUser.id, username: dbUser.username };

  const ts = Date.now();
  const goldItem = await createItem({ name: `Test_Gold_${ts}`, type: "GOLD", unit: "GRAM" });
  const supplier = await createAccount({
    name: `Test_Supplier_${ts}`,
    type: "CUSTOMER",
    customer_type: "PURCHASER",
    opening_pure_balance: "0",
    opening_cash_balance: "0"
  }, creator);

  console.log(`Created test supplier account: ${supplier.name} (${supplier.id})`);

  // --- BILL 1 ---
  console.log("\n--- Bill 1: Purchase 10g gold @ 10,000/g, pay 40,000 Rs ---");
  const p1 = await createPurchase({
    account_id: supplier.id,
    date: "2026-06-19",
    rate_per_gram: "10000",
    gold_items: [{ item_id: goldItem.id, quantity: "10.00000000", purity: "100.00" }],
    ornament_items: [],
    bank_amount: "40000.00",
  });

  // Let's get the server balances
  let balanceData = await getAccountAggregateBalances({ accountId: supplier.id });
  console.log("Bill 1 balances returned by server:");
  console.log(`  totalPure: ${balanceData.totalPure}`);
  console.log(`  totalCash: ${balanceData.totalCash}`);
  console.log(`  balancePure: ${balanceData.balancePure}`);
  console.log(`  lastRate: ${balanceData.lastRate}`);

  // Let's simulate frontend's opening balance calculations for PurchasePage.tsx (NEW FIXED LOGIC)
  let balancePure = -parseFloat(balanceData.balancePure || "0");
  let rate = parseFloat(balanceData.lastRate || "0");
  let feOpeningPure = balancePure;
  let feOpeningCash = feOpeningPure * rate;
  console.log(`Frontend Opening Balance computed: Pure = ${feOpeningPure.toFixed(4)}g, Cash = ${feOpeningCash.toFixed(2)} Rs`);

  // --- BILL 2 ---
  console.log("\n--- Bill 2: Purchase 5g gold @ 12,000/g, pay 10,000 Rs ---");
  const p2 = await createPurchase({
    account_id: supplier.id,
    date: "2026-06-19",
    rate_per_gram: "12000",
    gold_items: [{ item_id: goldItem.id, quantity: "5.00000000", purity: "100.00" }],
    ornament_items: [],
    bank_amount: "10000.00",
  });

  balanceData = await getAccountAggregateBalances({ accountId: supplier.id });
  console.log("Bill 2 balances returned by server:");
  console.log(`  totalPure: ${balanceData.totalPure}`);
  console.log(`  totalCash: ${balanceData.totalCash}`);
  console.log(`  balancePure: ${balanceData.balancePure}`);
  console.log(`  lastRate: ${balanceData.lastRate}`);

  balancePure = -parseFloat(balanceData.balancePure || "0");
  rate = parseFloat(balanceData.lastRate || "0");
  feOpeningPure = balancePure;
  feOpeningCash = feOpeningPure * rate;
  console.log(`Frontend Opening Balance computed: Pure = ${feOpeningPure.toFixed(4)}g, Cash = ${feOpeningCash.toFixed(2)} Rs`);

  // --- BILL 3: Settle partial payment ---
  console.log("\n--- Bill 3: Settle partial payment (pay 50,000 Rs @ 12,000/g, gold quantity 0) ---");
  const p3 = await createPurchase({
    account_id: supplier.id,
    date: "2026-06-19",
    rate_per_gram: "12000",
    gold_items: [{ item_id: goldItem.id, quantity: "0.00000000", purity: "100.00" }],
    ornament_items: [],
    bank_amount: "50000.00",
  });

  balanceData = await getAccountAggregateBalances({ accountId: supplier.id });
  console.log("Bill 3 balances returned by server:");
  console.log(`  totalPure: ${balanceData.totalPure}`);
  console.log(`  totalCash: ${balanceData.totalCash}`);
  console.log(`  balancePure: ${balanceData.balancePure}`);
  console.log(`  lastRate: ${balanceData.lastRate}`);

  balancePure = -parseFloat(balanceData.balancePure || "0");
  rate = parseFloat(balanceData.lastRate || "0");
  feOpeningPure = balancePure;
  feOpeningCash = feOpeningPure * rate;
  console.log(`Frontend Opening Balance computed: Pure = ${feOpeningPure.toFixed(4)}g, Cash = ${feOpeningCash.toFixed(2)} Rs`);

  // --- BILL 4: Settle full payment ---
  console.log("\n--- Bill 4: Settle full payment (pay remaining cash equivalent @ 15,000/g, gold quantity 0, rate increases to 15k) ---");
  const p4 = await createPurchase({
    account_id: supplier.id,
    date: "2026-06-19",
    rate_per_gram: "15000",
    gold_items: [{ item_id: goldItem.id, quantity: "0.00000000", purity: "100.00" }],
    ornament_items: [],
    bank_amount: "90000.00",
  });

  balanceData = await getAccountAggregateBalances({ accountId: supplier.id });
  console.log("Bill 4 balances returned by server:");
  console.log(`  totalPure: ${balanceData.totalPure}`);
  console.log(`  totalCash: ${balanceData.totalCash}`);
  console.log(`  balancePure: ${balanceData.balancePure}`);
  console.log(`  lastRate: ${balanceData.lastRate}`);

  balancePure = -parseFloat(balanceData.balancePure || "0");
  rate = parseFloat(balanceData.lastRate || "0");
  feOpeningPure = balancePure;
  feOpeningCash = feOpeningPure * rate;
  console.log(`Frontend Opening Balance computed: Pure = ${feOpeningPure.toFixed(4)}g, Cash = ${feOpeningCash.toFixed(2)} Rs`);

  console.log("\n--- Let's inspect listPurchases response for history table ---");
  const history = await listPurchases({ page: 1, limit: 10 });
  const row = history.data.find(h => h.group.account_id === supplier.id) as any;
  if (row) {
    console.log(`Row for supplier openingPure in listPurchases: ${row.openingPure}`);
    console.log(`Row for supplier openingCash in listPurchases: ${row.openingCash}`);
  }

  process.exit(0);
}

run().catch(console.error);
