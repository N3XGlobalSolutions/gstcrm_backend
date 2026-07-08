import { db } from "@/db";
import { SYSTEM_ACCOUNTS } from "@/config/constants";
import { getAccountItemBalances } from "@/lib/balance";
import { items } from "@/db/schema";
import { eq, and } from "drizzle-orm";

async function run() {
  const goldItems = await db
    .select()
    .from(items)
    .where(and(eq(items.type, "GOLD"), eq(items.is_deleted, false)));

  const goldItemIds = goldItems.map((item) => item.id);
  
  console.log("Gold Item IDs:", goldItemIds);
  console.log("SHOP_ID:", SYSTEM_ACCOUNTS.SHOP_ID);

  const balances = await getAccountItemBalances(SYSTEM_ACCOUNTS.SHOP_ID, goldItemIds);
  console.log("Balances:", JSON.stringify(balances, null, 2));
  process.exit(0);
}

run();
