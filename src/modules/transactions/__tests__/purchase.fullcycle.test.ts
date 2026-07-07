/**
 * PURCHASE — full-cycle bill suite (13 scenarios).
 *
 * Purchase semantics: supplier gives gold to SHOP (supplier pure ↓ / SHOP stock ↑),
 * SHOP pays cash to supplier. The shop's payable to the supplier, in rate-stable
 * grams, is:
 *   payable = −balancePure = Σ pureBought − cashPaid/rate − discount/rate
 * carried forward as the next bill's opening. (listPurchases flips the sign for
 * display via openingPure = −balancePure.)
 */
import { describe, it, expect } from "bun:test";
import { createPurchase, updatePurchase } from "@/modules/transactions/purchase/service";
import {
  makeSupplier, makeGoldItem, makeOrnamentItem, bal, itemGrams, purePure, close,
  SHOP, TODAY,
} from "./_harness";

const R = 6000;
const base = (over: any) => ({
  date: TODAY, rate_per_gram: String(R), gold_items: [], ornament_items: [],
  bank_amount: "0", ...over,
});
const line = (item: string, w: string, t: string) => ({ item_id: item, quantity: w, purity: t });
const payable = async (acct: string) => -(await bal(acct)).balancePure;

describe("PURCHASE full-cycle", () => {
  it("P1 — balance bill (shop owes supplier, no payment)", async () => {
    const s = await makeSupplier(); const g = await makeGoldItem();
    await createPurchase(base({ account_id: s, gold_items: [line(g, "100", "92")] }) as any);
    close(await payable(s), purePure(100, 92), 0.001, "P1 payable 92g");
    close(await itemGrams(SHOP, g), 100, 0.001, "P1 shop stock +100");
  });

  it("P2 — partial payment", async () => {
    const s = await makeSupplier(); const g = await makeGoldItem();
    await createPurchase(base({ account_id: s, gold_items: [line(g, "50", "91.6")], bank_amount: "100000" }) as any);
    close(await payable(s), purePure(50, 91.6) - 100000 / R, 0.001, "P2 payable − paid/rate");
  });

  it("P3 — full settlement (payable → 0)", async () => {
    const s = await makeSupplier(); const g = await makeGoldItem();
    const P = purePure(20, 90);
    await createPurchase(base({ account_id: s, gold_items: [line(g, "20", "90")], bank_amount: String(P * R) }) as any);
    close(await payable(s), 0, 0.001, "P3 settled");
  });

  it("P4 — multi gold items", async () => {
    const s = await makeSupplier(); const g1 = await makeGoldItem(); const g2 = await makeGoldItem();
    await createPurchase(base({ account_id: s, gold_items: [line(g1, "100", "92"), line(g2, "50", "75")] }) as any);
    close(await payable(s), purePure(100, 92) + purePure(50, 75), 0.001, "P4 ΣP 129.5");
  });

  it("P5 — ornament purchase creates shop lot", async () => {
    const s = await makeSupplier(); const orn = await makeOrnamentItem();
    await createPurchase(base({ account_id: s, ornament_items: [line(orn, "30", "91.6")] }) as any);
    close(await payable(s), purePure(30, 91.6), 0.001, "P5 payable 27.48");
    close(await itemGrams(SHOP, orn), 30, 0.001, "P5 shop ornament stock +30");
  });

  it("P6 — mixed gold + ornament", async () => {
    const s = await makeSupplier(); const g = await makeGoldItem(); const orn = await makeOrnamentItem();
    await createPurchase(base({ account_id: s, gold_items: [line(g, "10", "92")], ornament_items: [line(orn, "5", "90")] }) as any);
    close(await payable(s), purePure(10, 92) + purePure(5, 90), 0.001, "P6 ΣP 13.7");
  });

  it("P7 — cash discount reduces payable", async () => {
    const s = await makeSupplier(); const g = await makeGoldItem();
    await createPurchase(base({ account_id: s, gold_items: [line(g, "10", "92")], discount: "3000" }) as any);
    close(await payable(s), purePure(10, 92) - 3000 / R, 0.001, "P7 payable − discount/rate");
  });

  it("P8 — pure-gold discount reduces payable", async () => {
    const s = await makeSupplier(); const g = await makeGoldItem();
    await createPurchase(base({ account_id: s, gold_items: [line(g, "10", "92")], discount_pure: "0.5" }) as any);
    close(await payable(s), purePure(10, 92) - 0.5, 0.001, "P8 payable − 0.5g");
  });

  it("P9 — 3-decimal cash invariant (rate 14527.20, touch 94.32)", async () => {
    const s = await makeSupplier(); const g = await makeGoldItem();
    const rate = 14527.2;
    await createPurchase({ ...base({ account_id: s, gold_items: [line(g, "12.345", "94.32")] }), rate_per_gram: String(rate) } as any);
    const pure3dp = purePure(12.345, 94.32);
    const p = await payable(s);
    close(p, pure3dp, 0.0000001, "P9 payable is 3dp pure");
    close(p * rate, pure3dp * rate, 0.01, "P9 cash = 3dp×rate reconciles < ₹0.01");
  });

  it("P10 — rate change creates no phantom balance", async () => {
    const s = await makeSupplier(); const g = await makeGoldItem();
    // bill1 @5000 fully paid
    await createPurchase(base({ account_id: s, gold_items: [line(g, "10", "100")], rate_per_gram: "5000", bank_amount: String(10 * 5000) }) as any);
    close(await payable(s), 0, 0.001, "P10 bill1 settled at old rate");
    // bill2 @7000 unpaid — bill1 must NOT resurrect due to new rate
    await createPurchase(base({ account_id: s, gold_items: [line(g, "5", "100")], rate_per_gram: "7000" }) as any);
    close(await payable(s), 5, 0.001, "P10 only bill2's 5g remains, no phantom");
  });

  it("P11 — 4-bill lifecycle: carry forward then settle to zero", async () => {
    const s = await makeSupplier(); const g = await makeGoldItem();
    await createPurchase(base({ account_id: s, gold_items: [line(g, "20", "92")] }) as any);       // +18.4
    close(await payable(s), 18.4, 0.001, "P11 b1 18.4");
    await createPurchase(base({ account_id: s, gold_items: [line(g, "10", "92")], bank_amount: String(purePure(10, 92) * R) }) as any); // paid
    close(await payable(s), 18.4, 0.001, "P11 b2 still 18.4");
    await createPurchase(base({ account_id: s, gold_items: [line(g, "5", "90")] }) as any);        // +4.5
    const running = 18.4 + purePure(5, 90);
    close(await payable(s), running, 0.001, "P11 b3 22.9");
    const b4 = purePure(6, 92);
    await createPurchase(base({ account_id: s, gold_items: [line(g, "6", "92")], bank_amount: String((running + b4) * R) }) as any);
    close(await payable(s), 0, 0.001, "P11 full cycle settled");
  });

  it("P12 — stock increases exactly by bought grams", async () => {
    const s = await makeSupplier(); const g = await makeGoldItem();
    await createPurchase(base({ account_id: s, gold_items: [line(g, "123.456", "92")] }) as any);
    close(await itemGrams(SHOP, g), 123.456, 0.0005, "P12 stock +123.456");
  });

  it("P13 — update/reversal recomputes payable", async () => {
    const s = await makeSupplier(); const g = await makeGoldItem();
    const r = await createPurchase(base({ account_id: s, gold_items: [line(g, "10", "92")] }) as any);
    close(await payable(s), 9.2, 0.001, "P13 pre-edit 9.2");
    await updatePurchase({ ...base({ account_id: s, gold_items: [line(g, "15", "92")] }), id: (r as any).group.id } as any);
    close(await payable(s), purePure(15, 92), 0.001, "P13 post-edit 13.8");
    close(await itemGrams(SHOP, g), 15, 0.001, "P13 stock reflects edit");
  });
});
