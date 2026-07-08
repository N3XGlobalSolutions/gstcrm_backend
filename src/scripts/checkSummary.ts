import { db } from "@/db";
import { SYSTEM_ACCOUNTS } from "@/config/constants";
import { getAccountLotBalances, getAccountItemBalances } from "@/lib/balance";
import { items, accounts } from "@/db/schema";
import { eq, and, or } from "drizzle-orm";
import { toDecimal } from "@/lib/decimal";

async function run() {
  const [allItems, goldsmiths] = await Promise.all([
    db
      .select({ id: items.id, type: items.type })
      .from(items)
      .where(eq(items.is_deleted, false)),
    db
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          or(eq(accounts.type, "GOLDSMITH"), eq(accounts.customer_type, "GOLD_SMITH")),
          eq(accounts.is_deleted, false)
        )
      )
  ]);

  const goldItemIds = allItems.filter((i) => i.type === "GOLD").map((i) => i.id);
  const zero = toDecimal("0");

  const [shopLots, shopGoldBalances, mcLots] = await Promise.all([
    getAccountLotBalances(SYSTEM_ACCOUNTS.SHOP_ID),
    getAccountItemBalances(SYSTEM_ACCOUNTS.SHOP_ID, goldItemIds),
    Promise.resolve([]),
  ]);

  let gold_total_pure = zero;
  for (const bal of shopGoldBalances) {
    const pq = bal.pure_quantity ?? zero;
    if (isFinite(Number(pq))) {
      gold_total_pure = gold_total_pure.plus(pq);
    }
  }

  console.log("Calculated Gold Total Pure:", gold_total_pure.toFixed(3));
  process.exit(0);
}

run();
