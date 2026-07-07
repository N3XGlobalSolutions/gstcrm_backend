/**
 * SALES — full-cycle bill suite (16 scenarios).
 *
 * Sale semantics: SHOP gives gold to the customer (customer pure ↑), customer
 * pays cash (cash flows customer→SHOP). The rate-stable carried debt is
 *   balancePure = Σ pureSold − cashPaid/rate − discount/rate − tcs/rate + tds/rate
 * which becomes the NEXT bill's opening balance.
 */
import { describe, it, expect } from "bun:test";
import { createSale, updateSale, listSales } from "@/modules/transactions/sales/service";
import {
  makeCustomer, makeGoldItem, makeOrnamentItem, seedShopGold, seedShopOrnamentLot,
  bal, itemGrams, purePure, wastagePercent, wastageGram, close, round3,
  TEST_USER, SHOP, TODAY,
} from "./_harness";

const R = 6000;
const base = (over: any) => ({
  date: TODAY, rate_per_gram: String(R),
  items: [], bank_amount: "0", discount: "0", discount_pure: "0",
  balance_mode: "PURE", tds_enabled: false, tds_amount: "0",
  tcs_enabled: false, tcs_amount: "0", ...over,
});
const gline = (item: string, w: string, t: string, wm = "GRAM", wv = "0") =>
  ({ item_id: item, quantity: w, purity: t, wastage_mode: wm, wastage_value: wv });

describe("SALES full-cycle", () => {
  it("S1 — balance bill (full credit, no payment)", async () => {
    const c = await makeCustomer(); const g = await makeGoldItem();
    await seedShopGold(g, "100", "92");
    await createSale(base({ account_id: c, items: [gline(g, "10", "92")] }) as any, TEST_USER);
    const b = await bal(c);
    close(b.balancePure, purePure(10, 92), 0.0005, "S1 balancePure=9.2");
    close(b.totalCash, 0, 0.001, "S1 no cash moved");
    close(await itemGrams(SHOP, g), 90, 0.0005, "S1 shop stock 100→90");
  });

  it("S2 — partial payment", async () => {
    const c = await makeCustomer(); const g = await makeGoldItem();
    await seedShopGold(g, "100", "91.6");
    await createSale(base({ account_id: c, items: [gline(g, "20", "91.6")], bank_amount: "50000" }) as any, TEST_USER);
    const P = purePure(20, 91.6); // 18.32
    close((await bal(c)).balancePure, P - 50000 / R, 0.0005, "S2 partial balancePure");
    close((await bal(c)).totalCash, -50000, 0.01, "S2 cash out -50000");
  });

  it("S3 — full settlement (balance → 0)", async () => {
    const c = await makeCustomer(); const g = await makeGoldItem();
    await seedShopGold(g, "100", "90");
    const P = purePure(15, 90); // 13.5
    await createSale(base({ account_id: c, items: [gline(g, "15", "90")], bank_amount: String(P * R) }) as any, TEST_USER);
    close((await bal(c)).balancePure, 0, 0.0005, "S3 settled to zero");
  });

  it("S4 — multi-item bill", async () => {
    const c = await makeCustomer(); const g1 = await makeGoldItem(); const g2 = await makeGoldItem();
    await seedShopGold(g1, "100", "92"); await seedShopGold(g2, "100", "75");
    await createSale(base({ account_id: c, items: [gline(g1, "10", "92"), gline(g2, "5", "75")] }) as any, TEST_USER);
    close((await bal(c)).balancePure, purePure(10, 92) + purePure(5, 75), 0.001, "S4 ΣP=12.95");
  });

  it("S5 — wastage PERCENT mode", async () => {
    const c = await makeCustomer(); const g = await makeGoldItem();
    await seedShopGold(g, "100", "92");
    await createSale(base({ account_id: c, items: [gline(g, "10", "92", "PERCENT", "5")] }) as any, TEST_USER);
    const total = 10 + wastagePercent(10, 5, 92);
    close((await bal(c)).balancePure, round3(total * 0.92), 0.001, "S5 pure incl % wastage");
  });

  it("S6 — wastage GRAM mode", async () => {
    const c = await makeCustomer(); const g = await makeGoldItem();
    await seedShopGold(g, "100", "92");
    await createSale(base({ account_id: c, items: [gline(g, "10", "92", "GRAM", "0.05")] }) as any, TEST_USER);
    const total = 10 + wastageGram(10, 0.05); // 10.5
    close((await bal(c)).balancePure, round3(total * 0.92), 0.001, "S6 pure incl gram wastage");
  });

  it("S7 — cash discount reduces balance", async () => {
    const c = await makeCustomer(); const g = await makeGoldItem();
    await seedShopGold(g, "100", "92");
    await createSale(base({ account_id: c, items: [gline(g, "10", "92")], discount: "3000" }) as any, TEST_USER);
    close((await bal(c)).balancePure, purePure(10, 92) - 3000 / R, 0.001, "S7 balance − discount/rate");
  });

  it("S8 — pure-gold discount reduces balance", async () => {
    const c = await makeCustomer(); const g = await makeGoldItem();
    await seedShopGold(g, "100", "92");
    await createSale(base({ account_id: c, items: [gline(g, "10", "92")], discount_pure: "0.5" }) as any, TEST_USER);
    close((await bal(c)).balancePure, purePure(10, 92) - 0.5, 0.001, "S8 balance − 0.5g");
  });

  it("S9 — 3-decimal cash invariant (rate 14527.20, touch 94.32)", async () => {
    const c = await makeCustomer(); const g = await makeGoldItem();
    await seedShopGold(g, "100", "94.32");
    const rate = 14527.2;
    await createSale({ ...base({ account_id: c, items: [gline(g, "12.345", "94.32")] }), rate_per_gram: String(rate) } as any, TEST_USER);
    const pure3dp = purePure(12.345, 94.32);      // DB-rounded 3dp
    const rawPure = 12.345 * 0.9432;               // un-rounded
    const b = await bal(c);
    // Ledger must carry the 3dp pure exactly — not the raw product.
    close(b.balancePure, pure3dp, 0.0000001, "S9 balancePure is 3dp pure");
    // Cash owed = round3(pure) × rate, and reconciles with next opening (< ₹0.01 drift).
    close(b.balancePure * rate, pure3dp * rate, 0.01, "S9 cash = 3dp×rate");
    expect(Math.abs(pure3dp - rawPure)).toBeGreaterThan(0); // proves rounding actually happened
  });

  it("S10 — overpayment guard rejects payment > owed", async () => {
    const c = await makeCustomer(); const g = await makeGoldItem();
    await seedShopGold(g, "100", "92");
    let threw = false;
    try {
      await createSale(base({ account_id: c, items: [gline(g, "10", "92")], bank_amount: String(purePure(10, 92) * R + 5000) }) as any, TEST_USER);
    } catch (e: any) { threw = true; expect(String(e.message)).toContain("exceeds"); }
    expect(threw).toBe(true);
  });

  it("S11 — CASH balance mode settlement", async () => {
    const c = await makeCustomer(); const g = await makeGoldItem();
    await seedShopGold(g, "100", "92");
    const P = purePure(10, 92);
    await createSale(base({ account_id: c, items: [gline(g, "10", "92")], bank_amount: String(P * R), balance_mode: "CASH" }) as any, TEST_USER);
    close((await bal(c)).balancePure, 0, 0.0005, "S11 CASH-mode full settle");
  });

  it("S12 — TDS effect on carried balance (documents guard divergence)", async () => {
    const c = await makeCustomer(); const g = await makeGoldItem();
    await seedShopGold(g, "100", "92");
    await createSale(base({ account_id: c, items: [gline(g, "10", "92")], tds_enabled: true, tds_amount: "1200" }) as any, TEST_USER);
    // Ledger writes TDS as SHOP→customer ⇒ balancePure INCREASES by tds/rate.
    close((await bal(c)).balancePure, purePure(10, 92) + 1200 / R, 0.001, "S12 TDS ledger effect +tds/rate");
  });

  it("S13 — TCS effect on carried balance (documents guard divergence)", async () => {
    const c = await makeCustomer(); const g = await makeGoldItem();
    await seedShopGold(g, "100", "92");
    await createSale(base({ account_id: c, items: [gline(g, "10", "92")], tcs_enabled: true, tcs_amount: "1200" }) as any, TEST_USER);
    // Ledger writes TCS as customer→SHOP ⇒ balancePure DECREASES by tcs/rate.
    close((await bal(c)).balancePure, purePure(10, 92) - 1200 / R, 0.001, "S13 TCS ledger effect −tcs/rate");
  });

  it("S14 — 4-bill lifecycle: carry forward then settle to zero", async () => {
    const c = await makeCustomer(); const g = await makeGoldItem();
    await seedShopGold(g, "500", "92");
    // b1: 10g credit
    await createSale(base({ account_id: c, items: [gline(g, "10", "92")] }) as any, TEST_USER);
    close((await bal(c)).balancePure, 9.2, 0.001, "L14 after b1 = 9.2");
    // b2: 5g fully paid → running unchanged
    await createSale(base({ account_id: c, items: [gline(g, "5", "92")], bank_amount: String(purePure(5, 92) * R) }) as any, TEST_USER);
    close((await bal(c)).balancePure, 9.2, 0.001, "L14 after b2 still 9.2");
    // b3: 8g credit → running grows
    await createSale(base({ account_id: c, items: [gline(g, "8", "92")] }) as any, TEST_USER);
    const running = 9.2 + purePure(8, 92);
    close((await bal(c)).balancePure, running, 0.001, "L14 after b3 = 16.56");
    // b4: settle everything (pay current bill + clear whole running balance)
    const b4pure = purePure(6, 92);
    const owedCashAll = (running + b4pure) * R;
    await createSale(base({ account_id: c, items: [gline(g, "6", "92")], bank_amount: String(owedCashAll) }) as any, TEST_USER);
    close((await bal(c)).balancePure, 0, 0.001, "L14 full cycle settled to 0");
  });

  it("S15 — update/reversal recomputes balance", async () => {
    const c = await makeCustomer(); const g = await makeGoldItem();
    await seedShopGold(g, "200", "92");
    const r = await createSale(base({ account_id: c, items: [gline(g, "10", "92")] }) as any, TEST_USER);
    close((await bal(c)).balancePure, 9.2, 0.001, "S15 pre-edit 9.2");
    await updateSale({ ...base({ account_id: c, items: [gline(g, "12", "92")] }), id: (r as any).group.id } as any, TEST_USER);
    close((await bal(c)).balancePure, purePure(12, 92), 0.001, "S15 post-edit 11.04");
  });

  it("S16 — ornament sale from a specific lot", async () => {
    const c = await makeCustomer(); const orn = await makeOrnamentItem();
    await seedShopOrnamentLot(orn, "40", "91.6", "LOTS16");
    await createSale(base({
      account_id: c,
      items: [{ item_id: orn, lot_id: "LOTS16", quantity: "40", purity: "91.6", wastage_mode: "GRAM", wastage_value: "0" }],
    }) as any, TEST_USER);
    close((await bal(c)).balancePure, purePure(40, 91.6), 0.001, "S16 ornament pure 36.64");
    close(await itemGrams(SHOP, orn), 0, 0.0005, "S16 lot fully issued");
  });

  // ── Regression: wastage% is a PROFIT line, not physical gold ──────────────────
  it("S17 — sell the WHOLE ornament lot WITH wastage% (bug repro): must succeed, stock→0", async () => {
    const c = await makeCustomer(); const orn = await makeOrnamentItem();
    await seedShopOrnamentLot(orn, "40", "91.6", "LOTS17"); // exactly 40g in stock
    // Selling the full 40g with 8% wastage previously threw "exceeds stock".
    await createSale(base({
      account_id: c,
      items: [{ item_id: orn, lot_id: "LOTS17", quantity: "40", purity: "91.6", wastage_mode: "PERCENT", wastage_value: "8" }],
    }) as any, TEST_USER);
    // Physical gold that left the lot = 40g only → lot fully consumed.
    close(await itemGrams(SHOP, orn), 0, 0.0005, "S17 only physical 40g left stock → lot 0");
    // Customer billed for gross pure = (40 + wastage) × 91.6/100 (the profit).
    const grossPure = round3((40 + 40 * 8 / 91.6) * 0.916);
    close((await bal(c)).balancePure, grossPure, 0.002, "S17 customer billed gross pure incl. wastage");
  });

  it("S18 — pooled gold: sell ALL stock WITH wastage% must succeed", async () => {
    const c = await makeCustomer(); const g = await makeGoldItem();
    await seedShopGold(g, "10", "92"); // exactly 10g pooled stock
    await createSale(base({
      account_id: c, items: [gline(g, "10", "92", "PERCENT", "5")],
    }) as any, TEST_USER);
    close(await itemGrams(SHOP, g), 0, 0.0005, "S18 physical 10g left stock");
    const grossPure = round3((10 + 10 * 5 / 92) * 0.92);
    close((await bal(c)).balancePure, grossPure, 0.002, "S18 billed gross pure incl. wastage");
  });

  it("S19 — partial ornament sale with wastage removes only physical grams", async () => {
    const c = await makeCustomer(); const orn = await makeOrnamentItem();
    await seedShopOrnamentLot(orn, "40", "91.6", "LOTS19");
    await createSale(base({
      account_id: c,
      items: [{ item_id: orn, lot_id: "LOTS19", quantity: "25", purity: "91.6", wastage_mode: "PERCENT", wastage_value: "8" }],
    }) as any, TEST_USER);
    close(await itemGrams(SHOP, orn), 15, 0.0005, "S19 lot 40→15 (only 25 physical left)");
    const grossPure = round3((25 + 25 * 8 / 91.6) * 0.916);
    close((await bal(c)).balancePure, grossPure, 0.002, "S19 billed gross pure for 25g + wastage");
  });
});
