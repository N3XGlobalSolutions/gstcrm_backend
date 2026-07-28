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
import { createEntryGroup } from "@/lib/entryBuilder";
import { SYSTEM_ITEMS } from "@/config/constants";
import {
  makeSupplier, makeGoldItem, makeOrnamentItem, bal, cashFirstPayable, itemGrams, purePure, close,
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

  // ── P14: cross-bill settlement at a DIFFERENT rate — the loki phantom ──────────
  // A prior bill's gold is billed at one rate, then a later bill pays off the whole
  // running cash balance at a different rate. The per-bill balancePure formula divides
  // that payment by the later bill's rate and under-credits the earlier gold, leaving a
  // phantom gram balance even though the supplier is fully paid in cash. The Purchase
  // form's cash-first opening pure (goldCashBalance ÷ lastRate) must read 0.
  it("P14 — cross-rate settlement leaves no phantom (cash-first opening = 0)", async () => {
    const s = await makeSupplier(); const g = await makeGoldItem();
    // bill1 @1000, unpaid: 10g pure owed = ₹10,000
    await createPurchase(base({ account_id: s, gold_items: [line(g, "10", "100")], rate_per_gram: "1000" }) as any);
    // bill2 @10000: buy 5g pure (₹50,000) and pay off EVERYTHING (₹10,000 + ₹50,000)
    await createPurchase(base({ account_id: s, gold_items: [line(g, "5", "100")], rate_per_gram: "10000", bank_amount: "60000" }) as any);

    const b = await bal(s);
    // The old per-bill formula still shows a phantom — this documents the bug the fix avoids:
    close(-b.balancePure, 9, 0.001, "P14 per-bill balancePure shows 9g phantom");
    // Cash is fully settled: ₹0 owed.
    close(b.goldCashOut - b.totalCash, 0, 0.01, "P14 cash fully settled (₹0 owed)");
    // Cash-first opening pure (what the Purchase form now displays) = 0, no phantom.
    close(cashFirstPayable(b, 10000), 0, 0.001, "P14 cash-first opening pure = 0");
  });

  // ── P15: a rate-less opening-pure balance must survive the cash-first switch ───
  it("P15 — rate-less opening pure carries forward as grams (no regression)", async () => {
    const s = await makeSupplier();
    // 50g opening pure, no rate — exactly how account creation records an opening balance.
    await createEntryGroup({
      type: "OPENING", accountId: s, date: TODAY,
      entries: [{ fromAccountId: SHOP, toAccountId: s, itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID, quantity: "0", pureQuantity: "50" }],
    });
    const b = await bal(s);
    close(b.pureNoRate, 50, 0.001, "P15 pureNoRate captures rate-less opening pure");
    // No rated bill (lastRate = 0) and no cash movement → opening pure stays −50,
    // matching the prior −balancePure behaviour for opening balances.
    close(cashFirstPayable(b, 0), -50, 0.001, "P15 opening pure preserved (−50)");
  });

  // ── P16: editing a bill must not double-count via the reversal ────────────────
  // updatePurchase reverses the original (swapping from/to, same rate) then recreates.
  // The single-direction goldCashOut would otherwise count both the reversed original
  // AND the new bill; subtracting goldCashIn cancels the reversal so only the edit stands.
  it("P16 — cash-first opening is reversal-safe after an edit", async () => {
    const s = await makeSupplier(); const g = await makeGoldItem();
    const r = await createPurchase(base({ account_id: s, gold_items: [line(g, "10", "100")], rate_per_gram: "6000" }) as any);
    await updatePurchase({ ...base({ account_id: s, gold_items: [line(g, "15", "100")], rate_per_gram: "6000" }), id: (r as any).group.id } as any);

    const b = await bal(s);
    // The reversal really did record a gold-IN of the original 10g — the double-count source.
    close(b.goldCashIn, 10 * 6000, 1, "P16 reversal recorded 10g gold-in");
    // Net cash owed reflects only the edited 15g (not 25g), and cash-first opening = 15g.
    close(b.goldCashOut - b.goldCashIn - b.totalCash, 15 * 6000, 1, "P16 cash owed = 15g×6000");
    close(cashFirstPayable(b, 6000), 15, 0.001, "P16 cash-first opening = 15g (reversal-safe)");
  });

  // ── P17: per-item custom rates must reconcile to the EXACT per-row cash ────────
  // A bill with different rates per item stores a single group rate = the rounded
  // weighted average. Rebuilding cash as (total pure × avg rate) leaves a few-paise
  // phantom (loki's ₹0.06). goldCashOut must use each entry's own rate instead.
  it("P17 — per-item custom rates reconcile to exact cash (no avg-rate phantom)", async () => {
    const s = await makeSupplier(); const g1 = await makeGoldItem(); const g2 = await makeGoldItem();
    const trueCash = 9 * 5241 + 10 * 5212; // 99289 exactly (per-row); avg 99289/19 = 5225.7368…→5225.74
    await createPurchase({
      date: TODAY,
      rate_per_gram: "5225.74", // rounded weighted-average, exactly as the form stores it
      gold_items: [
        { item_id: g1, quantity: "9", purity: "100", rate: "5241" },
        { item_id: g2, quantity: "10", purity: "100", rate: "5212" },
      ],
      ornament_items: [],
      bank_amount: String(trueCash),
    } as any);

    const b = await bal(s);
    // goldCashOut is built from per-row rates → the exact ₹99,289, not ₹99,289.06.
    close(b.goldCashOut, trueCash, 0.001, "P17 goldCashOut = Σ(pure×rowRate), not pure×avgRate");
    // Fully paid ⇒ zero cash balance and zero cash-first opening — no lingering paise.
    close(b.goldCashOut - b.goldCashIn - b.totalCash, 0, 0.001, "P17 cash settled (no phantom)");
    close(cashFirstPayable(b, 5225.74), 0, 0.001, "P17 cash-first opening = 0");
  });
});
