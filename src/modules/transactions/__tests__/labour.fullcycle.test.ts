/**
 * LABOUR BILL — full-cycle suite (14 scenarios).
 *
 * A labour bill lives inside a permanent bill cycle for one goldsmith and moves
 * gold in 4 directions plus cash:
 *   gold_issue / ornament_issue   : SHOP → goldsmith  (goldsmith gold debt ↑)
 *   gold_receipt / ornament_recpt : goldsmith → SHOP  (goldsmith gold debt ↓)
 *   bank_paid / discount / tds     : SHOP → goldsmith cash  (balancePure ↑ by amt/rate)
 *   bank_receive / cash_conversion : goldsmith → SHOP cash  (balancePure ↓ by amt/rate)
 *
 * totalPure = issued − received (raw gold owed);
 * balancePure additionally nets cash movements at each bill's own rate.
 */
import { describe, it, expect } from "bun:test";
import { createCycle, createLabourBill, updateLabourBill } from "@/modules/transactions/labourBill/service";
import {
  makeGoldsmith, makeGoldItem, makeOrnamentItem, bal, itemGrams, purePure, round3, close,
  SHOP, TODAY,
} from "./_harness";

const R = 6000;
const cyc = async (acct: string) => (await createCycle({ account_id: acct, main_reason: "test" } as any)).id;
const gitem = (item: string, w: string, t: string, lot?: string) =>
  ({ item_id: item, quantity: w, purity: t, ...(lot ? { lot_id: lot } : {}) });
const oitem = (item: string, w: string, t: string, wp: string) =>
  ({ item_id: item, quantity: w, purity: t, wastage_percent: wp });
const lb = (over: any) => ({
  date: TODAY, rate_per_gram: String(R),
  gold_issue: [], gold_receipt: [], ornament_issue: [], ornament_receipt: [],
  cash_conversions: [], ...over,
});
// ornament gross+pure exactly like service calcOrnamentEntry
const ornGross = (w: number, t: number, wp: number) => round3(w + round3(w * (wp / 100) / (t / 100)));
const ornPure = (w: number, t: number, wp: number) => round3(ornGross(w, t, wp) * (t / 100));

describe("LABOUR full-cycle", () => {
  it("L1 — gold issue only (goldsmith owes gold)", async () => {
    const gs = await makeGoldsmith(); const g = await makeGoldItem(); const cid = await cyc(gs);
    await createLabourBill(lb({ account_id: gs, bill_cycle_id: cid, gold_issue: [gitem(g, "50", "92")] }) as any);
    close((await bal(gs)).totalPure, purePure(50, 92), 0.001, "L1 totalPure 46");
    close((await bal(gs)).balancePure, purePure(50, 92), 0.001, "L1 balancePure 46 (no cash)");
  });

  it("L2 — gold receipt only", async () => {
    const gs = await makeGoldsmith(); const g = await makeGoldItem(); const cid = await cyc(gs);
    await createLabourBill(lb({ account_id: gs, bill_cycle_id: cid, gold_receipt: [gitem(g, "20", "92")] }) as any);
    close((await bal(gs)).totalPure, -purePure(20, 92), 0.001, "L2 totalPure -18.4");
  });

  it("L3 — issue + receipt net", async () => {
    const gs = await makeGoldsmith(); const g = await makeGoldItem(); const cid = await cyc(gs);
    await createLabourBill(lb({ account_id: gs, bill_cycle_id: cid, gold_issue: [gitem(g, "50", "92")], gold_receipt: [gitem(g, "20", "92")] }) as any);
    close((await bal(gs)).totalPure, purePure(50, 92) - purePure(20, 92), 0.001, "L3 net 27.6");
  });

  it("L4 — ornament issue with wastage", async () => {
    const gs = await makeGoldsmith(); const orn = await makeOrnamentItem(); const cid = await cyc(gs);
    await createLabourBill(lb({ account_id: gs, bill_cycle_id: cid, ornament_issue: [oitem(orn, "40", "91.6", "8")] }) as any);
    close((await bal(gs)).totalPure, ornPure(40, 91.6, 8), 0.002, "L4 ornament issue pure incl wastage");
  });

  it("L5 — ornament receipt: stock = physical, debt = gross pure", async () => {
    const gs = await makeGoldsmith(); const orn = await makeOrnamentItem(); const cid = await cyc(gs);
    await createLabourBill(lb({ account_id: gs, bill_cycle_id: cid, ornament_receipt: [oitem(orn, "40", "91.6", "8")] }) as any);
    close((await bal(gs)).totalPure, -ornPure(40, 91.6, 8), 0.002, "L5 debt reduces by gross pure");
    close(await itemGrams(SHOP, orn), 40, 0.001, "L5 shop stock = physical 40g (not gross)");
  });

  it("L6 — bank paid increases gold-equivalent owed", async () => {
    const gs = await makeGoldsmith(); const g = await makeGoldItem(); const cid = await cyc(gs);
    await createLabourBill(lb({ account_id: gs, bill_cycle_id: cid, gold_issue: [gitem(g, "50", "92")], bank_paid: "60000" }) as any);
    close((await bal(gs)).balancePure, purePure(50, 92) + 60000 / R, 0.001, "L6 46 + 10");
    close((await bal(gs)).totalPure, purePure(50, 92), 0.001, "L6 totalPure unaffected by cash");
  });

  it("L7 — bank receive reduces balance", async () => {
    const gs = await makeGoldsmith(); const g = await makeGoldItem(); const cid = await cyc(gs);
    await createLabourBill(lb({ account_id: gs, bill_cycle_id: cid, gold_issue: [gitem(g, "50", "92")], bank_receive: "60000" }) as any);
    close((await bal(gs)).balancePure, purePure(50, 92) - 60000 / R, 0.001, "L7 46 − 10");
  });

  it("L8 — discount (shop→goldsmith cash)", async () => {
    const gs = await makeGoldsmith(); const g = await makeGoldItem(); const cid = await cyc(gs);
    await createLabourBill(lb({ account_id: gs, bill_cycle_id: cid, gold_issue: [gitem(g, "10", "92")], discount: "6000" }) as any);
    close((await bal(gs)).balancePure, purePure(10, 92) + 6000 / R, 0.001, "L8 9.2 + 1");
  });

  it("L9 — TDS (shop→goldsmith cash)", async () => {
    const gs = await makeGoldsmith(); const g = await makeGoldItem(); const cid = await cyc(gs);
    await createLabourBill(lb({ account_id: gs, bill_cycle_id: cid, gold_issue: [gitem(g, "10", "92")], tds: "6000" }) as any);
    close((await bal(gs)).balancePure, purePure(10, 92) + 6000 / R, 0.001, "L9 9.2 + 1");
  });

  it("L10 — cash conversion reduces gold debt", async () => {
    const gs = await makeGoldsmith(); const g = await makeGoldItem(); const cid = await cyc(gs);
    await createLabourBill(lb({
      account_id: gs, bill_cycle_id: cid, gold_issue: [gitem(g, "20", "92")],
      cash_conversions: [{ gold_grams: "5", rate_per_gram: String(R), cash_amount: String(5 * R) }],
    }) as any);
    close((await bal(gs)).balancePure, purePure(20, 92) - (5 * R) / R, 0.001, "L10 18.4 − 5");
    close((await bal(gs)).totalPure, purePure(20, 92), 0.001, "L10 totalPure still 18.4");
  });

  it("L11 — missing/unknown cycle is rejected", async () => {
    const gs = await makeGoldsmith(); const g = await makeGoldItem();
    let threw = false;
    try {
      await createLabourBill(lb({ account_id: gs, bill_cycle_id: "11111111-1111-1111-1111-111111111111", gold_issue: [gitem(g, "10", "92")] }) as any);
    } catch (e: any) { threw = true; expect(String(e.message)).toContain("cycle"); }
    expect(threw).toBe(true);
  });

  it("L12 — cycle belonging to another goldsmith is rejected", async () => {
    const gsA = await makeGoldsmith("A"); const gsB = await makeGoldsmith("B");
    const g = await makeGoldItem(); const cidA = await cyc(gsA);
    let threw = false;
    try {
      await createLabourBill(lb({ account_id: gsB, bill_cycle_id: cidA, gold_issue: [gitem(g, "10", "92")] }) as any);
    } catch (e: any) { threw = true; expect(String(e.message)).toContain("different goldsmith"); }
    expect(threw).toBe(true);
  });

  it("L13 — 4-bill cycle lifecycle nets correctly", async () => {
    const gs = await makeGoldsmith(); const g = await makeGoldItem(); const cid = await cyc(gs);
    await createLabourBill(lb({ account_id: gs, bill_cycle_id: cid, gold_issue: [gitem(g, "50", "92")] }) as any);   // +46
    await createLabourBill(lb({ account_id: gs, bill_cycle_id: cid, gold_receipt: [gitem(g, "20", "92")] }) as any); // -18.4
    close((await bal(gs)).totalPure, 27.6, 0.001, "L13 after 2 bills net 27.6");
    await createLabourBill(lb({ account_id: gs, bill_cycle_id: cid, gold_receipt: [gitem(g, "10", "92")] }) as any); // -9.2
    const netPure = purePure(50, 92) - purePure(20, 92) - purePure(10, 92); // 18.4
    // b4: goldsmith pays cash to settle remaining gold-equivalent
    await createLabourBill(lb({ account_id: gs, bill_cycle_id: cid, bank_receive: String(netPure * R) }) as any);
    close((await bal(gs)).totalPure, netPure, 0.001, "L13 totalPure 18.4 (cash doesn't change gold)");
    close((await bal(gs)).balancePure, 0, 0.002, "L13 balancePure settled to 0");
  });

  it("L14 — update/reversal recomputes balance", async () => {
    const gs = await makeGoldsmith(); const g = await makeGoldItem(); const cid = await cyc(gs);
    const r = await createLabourBill(lb({ account_id: gs, bill_cycle_id: cid, gold_issue: [gitem(g, "10", "92")] }) as any);
    close((await bal(gs)).totalPure, 9.2, 0.001, "L14 pre-edit 9.2");
    await updateLabourBill(lb({ account_id: gs, bill_cycle_id: cid, gold_issue: [gitem(g, "15", "92")], id: (r as any).group.id }) as any);
    close((await bal(gs)).totalPure, purePure(15, 92), 0.001, "L14 post-edit 13.8");
  });
});
