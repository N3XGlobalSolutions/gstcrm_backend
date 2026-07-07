import { describe, it, expect } from "bun:test";
import { createSale } from "@/modules/transactions/sales/service";
import {
  makeCustomer, makeGoldItem, seedShopGold, bal, itemGrams, purePure, close,
  TEST_USER, SHOP, TODAY,
} from "./_harness";

describe("smoke — isolated DB wiring", () => {
  it("connects, sells 10g @92 for cash, balances reconcile", async () => {
    const cust = await makeCustomer();
    const gold = await makeGoldItem();
    await seedShopGold(gold, "100", "92"); // shop now holds 100g @92

    const rate = 6000;
    await createSale({
      account_id: cust, date: TODAY, rate_per_gram: String(rate),
      items: [{ item_id: gold, quantity: "10", purity: "92", wastage_mode: "GRAM", wastage_value: "0" }],
      bank_amount: "0", discount: "0", discount_pure: "0", balance_mode: "PURE",
      tds_enabled: false, tds_amount: "0", tcs_enabled: false, tcs_amount: "0",
    } as any, TEST_USER);

    const P = purePure(10, 92); // 9.2 g
    const b = await bal(cust);
    close(b.balancePure, P, 0.0005, "balancePure (no payment ⇒ full gold owed)");
    close(b.totalPure, P, 0.0005, "totalPure");
    // Shop stock dropped from 100 to 90
    close(await itemGrams(SHOP, gold), 90, 0.0005, "shop stock after sale");
    expect(true).toBe(true);
  });
});
