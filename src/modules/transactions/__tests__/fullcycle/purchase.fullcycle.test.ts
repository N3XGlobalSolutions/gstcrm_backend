// Guard FIRST: refuses to run unless DATABASE_URL names a throwaway *_test database.
import "@/__tests__/fullcycle/guard";

/**
 * Full-cycle integration test: PURCHASE bills (supplier side).
 *
 * Calls the purchase service directly against a real, throwaway Postgres DB.
 *
 *   FULLTEST_DB=gstcrm_ft_purchase_test node scripts/fulltest/provision.mjs create
 *   DATABASE_URL=<that db> bun test --timeout 120000 \
 *     src/modules/transactions/__tests__/fullcycle/purchase.fullcycle.test.ts
 *
 * Sign rules used below (from purchase/service.ts):
 *   - pure owed to supplier  = -(supplier's balancePure)   (positive = shop owes supplier)
 *   - cash owed to supplier  = -(supplier's totalCash)     (what listPurchases shows as openingCash)
 *   - shop stock             = getBalance(SHOP, item)
 * Every test makes its own supplier and items, so tests never see each other's bills.
 * Expected numbers are worked out by hand in the comments, not copied from code output.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { accounts, entries, entryGroups, items } from "@/db/schema";
import { getAccountLotBalances, getAggregateBalances, getBalance } from "@/lib/balance";
import { SYSTEM_ACCOUNTS } from "@/config/constants";
import { sumPurchaseWastage, type PurchaseWastageRow } from "@/modules/reports/purchaseWastage";
import { CreatePurchaseSchema, UpdatePurchaseSchema } from "../../purchase/schema";
import {
  convertCashToGold,
  convertGoldToCash,
  createPurchase,
  deletePurchase,
  getPurchaseById,
  getPurchasePaymentStatus,
  listPurchases,
  settlePurchasePayment,
  undoGSTPurchaseConversion,
  updateGSTPurchaseConversion,
  updatePurchase,
} from "../../purchase/service";

const RUN = `PURFT-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const DATE = "2026-11-10";
const SHOP = SYSTEM_ACCOUNTS.SHOP_ID;

// ─── helpers ──────────────────────────────────────────────────────────────────

function uniqueEntryNo() {
  // High range so we never collide with seeded entry numbers.
  return 800_000_000 + Math.floor(Math.random() * 100_000_000);
}

let seq = 0;
async function makeSupplier(label: string): Promise<string> {
  const [acc] = await db
    .insert(accounts)
    .values({
      entry_no: uniqueEntryNo(),
      name: `${RUN} Supplier ${label} ${++seq}`,
      type: "CUSTOMER",
      customer_type: "PURCHASER",
    })
    .returning();
  return acc!.id;
}

async function makeItem(type: "GOLD" | "ORNAMENT", label: string): Promise<string> {
  const [item] = await db
    .insert(items)
    .values({ entry_no: uniqueEntryNo(), name: `${RUN} ${type} ${label} ${++seq}`, type, unit: "GRAM" })
    .returning();
  return item!.id;
}

type PurchaseIn = Parameters<typeof CreatePurchaseSchema.parse>[0];
/** Run the input through the real zod schema so defaults are applied exactly as the API does. */
const bill = (input: Record<string, unknown>) => CreatePurchaseSchema.parse(input as PurchaseIn);

const goldBill = (
  accountId: string,
  itemId: string,
  qty: string,
  purity: string,
  rate: string,
  extra: Record<string, unknown> = {},
) =>
  bill({
    account_id: accountId,
    date: DATE,
    rate_per_gram: rate,
    remarks: RUN,
    gold_items: [{ item_id: itemId, quantity: qty, purity }],
    ...extra,
  });

const r3 = (n: number) => Number(n.toFixed(3));
const r2 = (n: number) => Number(n.toFixed(2));

/** What the shop owes the supplier: pure grams and rupees (positive = shop owes). */
async function owed(accountId: string) {
  const b = await getAggregateBalances(accountId);
  return {
    pure: r3(-Number(b.balancePure.toString())),
    cash: r2(-Number(b.totalCash.toString())),
  };
}

async function stock(itemId: string): Promise<number> {
  return r3(Number((await getBalance(SHOP, itemId)).toString()));
}

async function groupRow(id: string) {
  const [g] = await db.select().from(entryGroups).where(eq(entryGroups.id, id)).limit(1);
  return g!;
}

async function livePurchases(accountId: string) {
  return db
    .select()
    .from(entryGroups)
    .where(
      and(
        eq(entryGroups.account_id, accountId),
        eq(entryGroups.type, "PURCHASE"),
        eq(entryGroups.is_deleted, false),
      ),
    );
}

// bun's `expect(promise).rejects` hung on DB-backed rejections, so capture by hand.
async function errorOf(p: PromiseLike<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

beforeAll(async () => {
  // Sanity: seeded SHOP account must exist in the test DB.
  const [shop] = await db.select().from(accounts).where(eq(accounts.id, SHOP)).limit(1);
  expect(shop?.type).toBe("SHOP");
});

// ─── tests ────────────────────────────────────────────────────────────────────

describe("purchase full cycle", () => {
  it("1. credit purchase of 10 g gold at 91.6: shop owes supplier 9.160 g pure and gold stock goes up 10 g", async () => {
    const sup = await makeSupplier("credit");
    const gold = await makeItem("GOLD", "credit");

    const { group, entries: rows } = await createPurchase(goldBill(sup, gold, "10", "91.6", "6000"));

    expect(group.type).toBe("PURCHASE");
    expect(group.bill_no).toBe(1); // first purchase bill for this supplier
    expect(rows.length).toBe(1); // just the gold row — no payment / discount rows
    expect(rows[0]!.from_account_id).toBe(sup);
    expect(rows[0]!.to_account_id).toBe(SHOP);
    expect(Number(rows[0]!.pure_quantity)).toBe(9.16); // 10 × 91.6% = 9.160

    // PURE mode: the debt is in grams, no cash moved yet.
    expect(await owed(sup)).toEqual({ pure: 9.16, cash: 0 });
    expect(await stock(gold)).toBe(10);

    // Bill's own cash value: 9.160 g × ₹6000 = ₹54,960, nothing paid.
    const status = await getPurchasePaymentStatus({ id: group.id });
    expect(status).toEqual({ currentCash: 54960, paid: 0, balance: 54960, isConversionEntry: false });
  });

  it("2. partial payment on the bill, then paying the rest: balance due drops to 0", async () => {
    const sup = await makeSupplier("pay");
    const gold = await makeItem("GOLD", "pay");

    // 9.160 g × ₹6000 = ₹54,960; ₹20,000 paid by bank on the bill itself.
    const { group } = await createPurchase(
      goldBill(sup, gold, "10", "91.6", "6000", { bank_amount: "20000", bank_details: "SBI" }),
    );
    const s0 = await getPurchasePaymentStatus({ id: group.id });
    expect(s0.paid).toBe(20000);
    expect(s0.balance).toBe(34960);

    // ₹10,000 more in cash → ₹24,960 left.
    let s = await settlePurchasePayment({ id: group.id, amount: "10000", method: "CASH" });
    expect(s.balance).toBe(24960);
    expect(s.entry.remarks).toBe("Cash");
    expect(s.entry.from_account_id).toBe(SHOP);

    // BANK payment needs a bank account.
    expect(await errorOf(settlePurchasePayment({ id: group.id, amount: "100", method: "BANK" }))).toBe(
      "Select a bank account.",
    );

    // Pay the rest by bank → fully paid.
    s = await settlePurchasePayment({ id: group.id, amount: "24960", method: "BANK", bank_details: "HDFC" });
    expect(s.balance).toBe(0);
    expect(s.paid).toBe(54960);

    expect(await errorOf(settlePurchasePayment({ id: group.id, amount: "1", method: "CASH" }))).toBe(
      "This bill is already fully paid.",
    );

    // Ledger: supplier gave 9.160 g pure; shop paid out ₹54,960 in total.
    // In rupees: 9.160 × 6000 − 54,960 = 0 left to pay.
    const b = await getAggregateBalances(sup);
    expect(r3(-Number(b.balancePure))).toBe(9.16);
    expect(r2(Number(b.totalCash))).toBe(54960);
    expect(r2(Number(b.goldCashOut) - Number(b.goldCashIn) - Number(b.totalCash))).toBe(0);
    expect(await stock(gold)).toBe(10);
  });

  it("3. cash-mode ornament bill with wastage %, discount, TDS, TCS and round off: closing cash matches the bill math", async () => {
    const sup = await makeSupplier("math");
    const orn = await makeItem("ORNAMENT", "math");

    // 20 g at 91.6 = 18.320 g pure × ₹6123.45 = ₹1,12,181.604 → Cash Purchase Charge ₹1,12,181.60
    // Bill balance = 112181.604 − 10000 (bank) − 500 (discount) − 100 (TDS) + 50 (TCS) = 101631.604
    // Round off to ₹1,01,632 → +0.396 → posted +₹0.40 (owed goes up)
    // Ledger closing = 112181.60 + 50 + 0.40 − 10000 − 500 − 100 = ₹1,01,632.00
    const { group, entries: rows } = await createPurchase(
      bill({
        account_id: sup,
        date: DATE,
        rate_per_gram: "6123.45",
        remarks: RUN,
        ornament_items: [{ item_id: orn, quantity: "20", purity: "91.6", wastage_percent: "5" }],
        balance_mode: "CASH",
        bank_amount: "10000",
        bank_details: "SBI",
        discount: "500",
        tds_enabled: true,
        tds_amount: "100",
        tcs_enabled: true,
        tcs_amount: "50",
      }),
    );

    const byRemark = (r: string) => rows.filter((e) => e.remarks === r);
    expect(Number(byRemark("Cash Purchase Charge")[0]!.quantity)).toBe(112181.6);
    expect(Number(byRemark("Discount")[0]!.quantity)).toBe(500);
    expect(Number(byRemark("TDS Adjustment")[0]!.quantity)).toBe(100);
    expect(Number(byRemark("TCS Adjustment")[0]!.quantity)).toBe(50);
    const ro = byRemark("Round Off")[0]!;
    expect(Number(ro.quantity)).toBe(0.4);
    expect(ro.from_account_id).toBe(sup); // owed goes UP

    // Cash mode: no pure debt, only cash.
    expect(await owed(sup)).toEqual({ pure: 0, cash: 101632 });

    // Bill status: currentCash 112181.60, paid = 10000 + 500 + 100 − 50 = 10550, +0.40 round off.
    const s = await getPurchasePaymentStatus({ id: group.id });
    expect(s.currentCash).toBe(112181.6);
    expect(s.paid).toBe(10550);
    expect(s.balance).toBe(101632);

    // Edit form can rehydrate: discount split out, only the real bank payment counts as payment.
    const view = await getPurchaseById({ id: group.id });
    expect(view.discountEntries.length).toBe(1);
    expect(view.paymentEntries.map((p) => Number(p.entry.quantity))).toEqual([10000]);

    // Physical stock still goes up 20 g even though the bill is kept in cash.
    expect(await stock(orn)).toBe(20);

    // Wastage % is stored on the row (not charged in the ledger) …
    const orow = rows.find((e) => e.item_id === orn)!;
    expect(orow.wastage_mode).toBe("PERCENT");
    expect(Number(orow.wastage_value)).toBe(5);
    expect(Number(orow.wastage_quantity)).toBe(0);
    expect(Number(orow.pure_quantity)).toBe(0); // cash mode zeroes pure

    // … and the purchase-wastage report reads it as a cost: 20 g × 5% = 1.000 g × ₹6123.45.
    const wrow: PurchaseWastageRow = {
      quantity: orow.quantity,
      purity: orow.purity,
      wastage_mode: orow.wastage_mode,
      wastage_value: orow.wastage_value,
      wastage_quantity: orow.wastage_quantity,
      rate: orow.rate ?? group.rate_per_gram,
    };
    const w = sumPurchaseWastage([wrow]);
    expect(Number(w.grams.toFixed(3))).toBe(1);
    expect(Number(w.value.toFixed(2))).toBe(6123.45);
  });

  // Was B13 (fixed 2026-11-11): Round Off was worked out from the UNROUNDED bill value while
  // the Cash Purchase Charge is posted rounded to 2 dp, so a half-paisa value closed 1 paisa
  // off a whole rupee. Round Off now uses the posted 2 dp amounts.
  // 5 g at 99.9 = 4.995 g × ₹6001 = ₹29,974.995 → charge posted ₹29,975.00 → no round off
  // → closing ₹29,975.00 (was ₹29,975.01).
  it("round off lands on a whole rupee even when the bill value ends in half a paisa", async () => {
    const sup = await makeSupplier("halfpaisa");
    const gold = await makeItem("GOLD", "halfpaisa");

    await createPurchase(goldBill(sup, gold, "5", "99.9", "6001", { balance_mode: "CASH" }));

    // ₹29,975.00 (whole rupee), and no Round Off entry is needed.
    expect((await owed(sup)).cash).toBe(29975);
    const [g] = await livePurchases(sup);
    expect((await getPurchasePaymentStatus({ id: g!.id })).balance).toBe(29975);
  });

  // Was B13 (same root cause): the Discount entry is posted rounded but round off used the
  // unrounded discount. Discount of 0.1 g × ₹6123.45 = ₹612.345.
  // 18.320 g × 6123.45 = 112181.604 → charge 112181.60; discount 500 + 612.345 = 1112.345 → posted 1112.35
  // bill balance (posted) = 112181.60 − 10000 − 1112.35 = 101069.25 → round off −0.25
  // ledger = 112181.60 − 10000 − 1112.35 − 0.25 = 101069.00  (was 101068.99)
  it("round off lands on a whole rupee when a discount in grams gives half-paise", async () => {
    const sup = await makeSupplier("discpure");
    const gold = await makeItem("GOLD", "discpure");

    await createPurchase(
      goldBill(sup, gold, "20", "91.6", "6123.45", {
        balance_mode: "CASH",
        bank_amount: "10000",
        bank_details: "SBI",
        discount: "500",
        discount_pure: "0.1",
      }),
    );

    // ₹1,01,069.00 (was ₹1,01,068.99).
    expect((await owed(sup)).cash).toBe(101069);
  });

  it("4. ornament purchase puts a new lot into shop stock; deleting the bill takes the lot out again", async () => {
    const sup = await makeSupplier("lot");
    const orn = await makeItem("ORNAMENT", "lot");

    const { group, entries: rows } = await createPurchase(
      bill({
        account_id: sup,
        date: DATE,
        rate_per_gram: "6000",
        ornament_items: [{ item_id: orn, quantity: "8.5", purity: "91.6" }],
      }),
    );

    const lotId = rows[0]!.lot_id;
    expect(lotId).toBeTruthy(); // ORNAMENT into SHOP gets a lot id

    const lots = await getAccountLotBalances(SHOP, [orn]);
    expect(lots.length).toBe(1);
    expect(lots[0]!.lot_id).toBe(lotId!);
    expect(Number(lots[0]!.quantity)).toBe(8.5);
    expect(Number(lots[0]!.purity)).toBe(91.6);
    expect(Number(Number(lots[0]!.pure_quantity).toFixed(3))).toBe(7.786); // 8.5 × 91.6%
    // Purchase has no piece-count field (schema has none), so pieces stay 0.
    expect(Number(lots[0]!.pieces)).toBe(0);

    expect(await owed(sup)).toEqual({ pure: 7.786, cash: 0 });

    await deletePurchase({ id: group.id });
    expect(await getAccountLotBalances(SHOP, [orn])).toEqual([]);
    expect(await stock(orn)).toBe(0);
    expect(await owed(sup)).toEqual({ pure: 0, cash: 0 });
  });

  it("5. running balance over 3 bills: each bill's opening is the previous bill's closing", async () => {
    const sup = await makeSupplier("chain");
    const gold = await makeItem("GOLD", "chain");

    // Bill 1 — PURE: 10 g @ 91.6 → +9.160 g. Closing: 9.160 g, ₹0
    const { group: b1 } = await createPurchase(goldBill(sup, gold, "10", "91.6", "6000"));
    await Bun.sleep(20);
    // Bill 2 — CASH: 5 g @ 99.9 = 4.995 g × ₹6500 = ₹32,467.50, paid ₹1,000
    //   bill balance 31467.50 → round off +0.50 → cash +32467.50 + 0.50 − 1000 = +₹31,468
    //   Closing: 9.160 g, ₹31,468
    const { group: b2 } = await createPurchase(
      goldBill(sup, gold, "5", "99.9", "6500", { balance_mode: "CASH", bank_amount: "1000", bank_details: "SBI" }),
    );
    await Bun.sleep(20);
    // Bill 3 — PURE: 2 g @ 91.6 → +1.832 g, paid ₹5,000 → Closing: 10.992 g, ₹26,468
    const { group: b3 } = await createPurchase(
      goldBill(sup, gold, "2", "91.6", "6100", { bank_amount: "5000", bank_details: "SBI" }),
    );

    const expected = [
      { id: b1.id, openPure: 0, openCash: 0 },
      { id: b2.id, openPure: 9.16, openCash: 0 },
      { id: b3.id, openPure: 9.16, openCash: 31468 },
    ];

    for (const e of expected) {
      const v = await getPurchaseById({ id: e.id });
      expect(r3(Number(v.openingPure))).toBe(e.openPure);
      expect(r2(Number(v.openingCash))).toBe(e.openCash);
    }

    // History list shows the same openings.
    const list = await listPurchases({ page: 1, limit: 100 });
    for (const e of expected) {
      // listPurchases' early-return branch widens the type; the data rows do carry openings.
      const row = list.data.find((d) => d.group.id === e.id) as
        | { openingPure: string; openingCash: string }
        | undefined;
      expect(row).toBeDefined();
      expect(r3(Number(row!.openingPure))).toBe(e.openPure);
      expect(r2(Number(row!.openingCash))).toBe(e.openCash);
    }

    expect(await owed(sup)).toEqual({ pure: 10.992, cash: 26468 });
    expect(await stock(gold)).toBe(17); // 10 + 5 + 2 g physical
    expect([b1.bill_no, b2.bill_no, b3.bill_no]).toEqual([1, 2, 3]);
  });

  it("6. gold→cash and cash→gold conversion, with the 'only X outstanding' guards; stock untouched", async () => {
    const sup = await makeSupplier("conv");
    const gold = await makeItem("GOLD", "conv");

    // No balance yet → nothing to convert.
    expect(await errorOf(convertGoldToCash({ account_id: sup, gold_grams: "1", rate_per_gram: "6500" }))).toBe(
      "This account has no outstanding gold balance to convert.",
    );
    expect(await errorOf(convertCashToGold({ account_id: sup, cash_amount: "100", rate_per_gram: "6500" }))).toBe(
      "This account has no outstanding cash balance to convert.",
    );

    await createPurchase(goldBill(sup, gold, "10", "91.6", "6000")); // 9.160 g owed

    expect(await errorOf(convertGoldToCash({ account_id: sup, gold_grams: "10", rate_per_gram: "6500" }))).toBe(
      "Cannot convert 10.000g — only 9.160g of gold is outstanding for this account.",
    );

    // 4 g × ₹6500 = ₹26,000 → owed 5.160 g + ₹26,000
    const { group: g2c } = await convertGoldToCash({ account_id: sup, gold_grams: "4", rate_per_gram: "6500" });
    expect(g2c.bill_no).toBeNull(); // conversions are not bills
    expect(g2c.remarks).toBe("Gold to Cash Conversion (4.000g @ ₹6500.00/g)");
    expect(await owed(sup)).toEqual({ pure: 5.16, cash: 26000 });

    expect(await errorOf(convertCashToGold({ account_id: sup, cash_amount: "30000", rate_per_gram: "6500" }))).toBe(
      "Cannot convert ₹30000.00 — only ₹26000.00 of cash is outstanding for this account.",
    );

    // ₹13,000 ÷ ₹6500 = 2.000 g → owed 7.160 g + ₹13,000
    const { group: c2g } = await convertCashToGold({ account_id: sup, cash_amount: "13000", rate_per_gram: "6500" });
    expect(c2g.remarks).toBe("Cash to Gold Conversion (2.000g @ ₹6500.00/g)");
    expect(await owed(sup)).toEqual({ pure: 7.16, cash: 13000 });

    // Conversions are pure bookkeeping: gold stock still exactly the 10 g bought.
    expect(await stock(gold)).toBe(10);

    // A conversion has no bill balance to pay.
    const st = await getPurchasePaymentStatus({ id: g2c.id });
    expect(st.isConversionEntry).toBe(true);
    expect(await errorOf(settlePurchasePayment({ id: g2c.id, amount: "1", method: "CASH" }))).toBe(
      "Conversion entries have no bill balance to settle.",
    );

    // Deleting the latest conversion undoes just that conversion.
    await deletePurchase({ id: c2g.id });
    expect(await owed(sup)).toEqual({ pure: 5.16, cash: 26000 });
  });

  // BUG: deleteGuards.ts says "Conversion entries carry no bill_no and are bookkeeping, not
  // bills, so they never stand in the way of a delete." But the "latest bill" query orders by
  // desc(bill_no) (src/lib/deleteGuards.ts:80) and Postgres sorts NULLs FIRST on DESC, so a
  // conversion (bill_no NULL) made after the bill is picked as "latest" and the delete is refused.
  // Skipped: owner 2026-11-11 — bills are not deleted in practice (B7 not fixed).
  it.skip("BUG: a gold→cash conversion after the bill does not block deleting that bill", async () => {
    const sup = await makeSupplier("convdel");
    const gold = await makeItem("GOLD", "convdel");

    const { group } = await createPurchase(goldBill(sup, gold, "10", "91.6", "6000"));
    await convertGoldToCash({ account_id: sup, gold_grams: "1", rate_per_gram: "6000" });

    // Expected: null (delete allowed). Actual today: "Only this party's most recent purchase can be deleted…"
    expect(await errorOf(deletePurchase({ id: group.id }))).toBeNull();
  });

  it("7. editing the latest bill: old one reversed, same bill/entry no, balance and stock follow the new figures", async () => {
    const sup = await makeSupplier("edit");
    const gold = await makeItem("GOLD", "edit");

    const { group: orig } = await createPurchase(
      goldBill(sup, gold, "10", "91.6", "6000", { bank_amount: "1000", bank_details: "SBI" }),
    );
    expect(await owed(sup)).toEqual({ pure: 9.16, cash: -1000 });

    // Edit: 12 g @ 91.6 = 10.992 g, ₹2,000 paid
    const { group: edited } = await updatePurchase(
      UpdatePurchaseSchema.parse({
        ...goldBill(sup, gold, "12", "91.6", "6000", { bank_amount: "2000", bank_details: "SBI" }),
        id: orig.id,
      }),
    );

    const old = await groupRow(orig.id);
    expect(old.is_deleted).toBe(true);
    expect(old.reversed_by).not.toBeNull();
    const rev = await groupRow(old.reversed_by!);
    expect(rev.type).toBe("REVERSAL");
    expect(rev.reversal_of).toBe(orig.id);

    expect(edited.id).not.toBe(orig.id);
    expect(edited.bill_no).toBe(orig.bill_no);
    expect(edited.entry_no).toBe(orig.entry_no);

    // Nothing doubled: only the new version counts.
    expect((await livePurchases(sup)).map((g) => g.id)).toEqual([edited.id]);
    expect(await owed(sup)).toEqual({ pure: 10.992, cash: -2000 });
    expect(await stock(gold)).toBe(12);
    expect((await getPurchasePaymentStatus({ id: edited.id })).balance).toBe(r2(10.992 * 6000 - 2000));

    // A newer bill makes the edited one "old" → further edits refused, nothing changes.
    await createPurchase(goldBill(sup, gold, "1", "91.6", "6000"));
    const err = await errorOf(
      updatePurchase(UpdatePurchaseSchema.parse({ ...goldBill(sup, gold, "50", "91.6", "6000"), id: edited.id })),
    );
    expect(err).toBe("Only the most recent purchase bill for this supplier can be edited.");
    expect((await groupRow(edited.id)).is_deleted).toBe(false);
    expect(await owed(sup)).toEqual({ pure: r3(10.992 + 0.916), cash: -2000 });
    expect(await stock(gold)).toBe(13);
  });

  it("7b. editing a cash-mode bill keeps the pure balance at 0 (reversal does not invent grams)", async () => {
    const sup = await makeSupplier("editcash");
    const gold = await makeItem("GOLD", "editcash");

    // 10 g @ 91.6 = 9.160 × 6000 = ₹54,960 (whole rupee, no round off)
    const { group } = await createPurchase(goldBill(sup, gold, "10", "91.6", "6000", { balance_mode: "CASH" }));
    expect(await owed(sup)).toEqual({ pure: 0, cash: 54960 });

    // 8 g @ 91.6 = 7.328 × 6000 = ₹43,968
    await updatePurchase(
      UpdatePurchaseSchema.parse({ ...goldBill(sup, gold, "8", "91.6", "6000", { balance_mode: "CASH" }), id: group.id }),
    );
    expect(await owed(sup)).toEqual({ pure: 0, cash: 43968 });
    expect(await stock(gold)).toBe(8);
  });

  // B1 (purchase side): the edit reverses the old version and posts the new one in ONE
  // transaction, so a refused save leaves the original bill exactly as it was.
  it("7c. a refused edit leaves the original bill intact (all-or-nothing)", async () => {
    const sup = await makeSupplier("editatomic");
    const gold = await makeItem("GOLD", "editatomic");

    const { group: orig } = await createPurchase(
      goldBill(sup, gold, "10", "91.6", "6000", { bank_amount: "1000", bank_details: "SBI" }),
    );

    const intact = async () => {
      const g = await groupRow(orig.id);
      expect(g.is_deleted).toBe(false);
      expect(g.reversed_by).toBeNull();
      // No stray REVERSAL group was left behind for it.
      expect(await db.select().from(entryGroups).where(eq(entryGroups.reversal_of, orig.id))).toEqual([]);
      expect((await livePurchases(sup)).map((x) => x.id)).toEqual([orig.id]);
      expect(await owed(sup)).toEqual({ pure: 9.16, cash: -1000 });
      expect(await stock(gold)).toBe(10);
    };

    // (a) Refused by the service's own rule: a direct (touch 0) row on a PURE bill.
    expect(
      await errorOf(
        updatePurchase(
          UpdatePurchaseSchema.parse({ ...goldBill(sup, gold, "2", "0", "6000"), id: orig.id }),
        ),
      ),
    ).toBe("Direct purchase items (touch 0) are valued in cash — set Maintain In to Cash");
    await intact();

    // (b) Fails mid-save, AFTER the reversal ran: the item does not exist (foreign-key
    // error on the new entry). Before the fix this left the bill reversed and gone.
    const err = await errorOf(
      updatePurchase(
        UpdatePurchaseSchema.parse({ ...goldBill(sup, crypto.randomUUID(), "12", "91.6", "6000"), id: orig.id }),
      ),
    );
    expect(err).not.toBeNull();
    await intact();

    // A valid edit afterwards still works and keeps bill / entry no.
    const { group: edited } = await updatePurchase(
      UpdatePurchaseSchema.parse({ ...goldBill(sup, gold, "12", "91.6", "6000"), id: orig.id }),
    );
    expect(edited.bill_no).toBe(orig.bill_no);
    expect(edited.entry_no).toBe(orig.entry_no);
    expect(await owed(sup)).toEqual({ pure: 10.992, cash: 0 });
    expect(await stock(gold)).toBe(12);
  });

  it("8. deleting the latest bill puts balance and stock back; older bills must wait", async () => {
    const sup = await makeSupplier("del");
    const gold = await makeItem("GOLD", "del");

    const { group: b1 } = await createPurchase(goldBill(sup, gold, "10", "91.6", "6000"));
    const before = await owed(sup);
    const stockBefore = await stock(gold);
    expect(before).toEqual({ pure: 9.16, cash: 0 });
    expect(stockBefore).toBe(10);

    // Bill 2: 5 g @ 99.9 = 4.995 g, ₹3,000 paid
    const { group: b2 } = await createPurchase(
      goldBill(sup, gold, "5", "99.9", "6000", { bank_amount: "3000", bank_details: "SBI" }),
    );
    expect(await owed(sup)).toEqual({ pure: 14.155, cash: -3000 });
    expect(await stock(gold)).toBe(15);

    expect(await errorOf(deletePurchase({ id: b1.id }))).toBe(
      "Only this party's most recent purchase can be deleted. Delete the later purchases first.",
    );

    expect(await deletePurchase({ id: b2.id })).toEqual({ success: true, id: b2.id });
    expect(await owed(sup)).toEqual(before);
    expect(await stock(gold)).toBe(stockBefore);
    expect((await groupRow(b2.id)).is_deleted).toBe(true);
    expect(await errorOf(getPurchaseById({ id: b2.id }))).toBe("Purchase not found");
    expect(await errorOf(deletePurchase({ id: b2.id }))).toBe("This purchase is already deleted.");

    // Now bill 1 is the latest and can go too → everything back to zero.
    await deletePurchase({ id: b1.id });
    expect(await owed(sup)).toEqual({ pure: 0, cash: 0 });
    expect(await stock(gold)).toBe(0);
    expect(await livePurchases(sup)).toEqual([]);

    // Raw ledger check, independent of balance.ts: every row cancelled out.
    const rows = await db.select().from(entries).where(eq(entries.item_id, gold));
    const net = rows.reduce((s, r) => s + (r.to_account_id === SHOP ? 1 : -1) * Number(r.quantity), 0);
    expect(r3(net)).toBe(0);
  });

  it("9. overpayment guard: Pay popup refuses more than the bill's balance; bank amount on the bill itself is not capped", async () => {
    const sup = await makeSupplier("over");
    const gold = await makeItem("GOLD", "over");

    const { group } = await createPurchase(goldBill(sup, gold, "10", "91.6", "6000")); // ₹54,960
    expect(await errorOf(settlePurchasePayment({ id: group.id, amount: "60000", method: "CASH" }))).toBe(
      "Payment cannot exceed the balance due (₹54960.00).",
    );
    expect(await errorOf(settlePurchasePayment({ id: group.id, amount: "54960.02", method: "CASH" }))).toBe(
      "Payment cannot exceed the balance due (₹54960.00).",
    );
    // Nothing was written by the refused payments.
    expect((await getPurchasePaymentStatus({ id: group.id })).paid).toBe(0);
    expect(await owed(sup)).toEqual({ pure: 9.16, cash: 0 });

    // Guard on the bill form was removed on purpose: paying ₹60,000 against ₹54,960 is accepted
    // and the bill shows ₹5,040 paid in advance.
    const sup2 = await makeSupplier("over2");
    const { group: g2 } = await createPurchase(
      goldBill(sup2, gold, "10", "91.6", "6000", { bank_amount: "60000", bank_details: "SBI" }),
    );
    expect((await getPurchasePaymentStatus({ id: g2.id })).balance).toBe(-5040);
  });

  it("10. a bill converted to GST cannot be deleted until the GST conversion is undone", async () => {
    const sup = await makeSupplier("gst");
    const gold = await makeItem("GOLD", "gst");

    const { group } = await createPurchase(goldBill(sup, gold, "10", "91.6", "6000"));
    await updateGSTPurchaseConversion({ id: group.id, gst_amount: "1648.80", tds_amount: "0", tcs_amount: "0" });

    expect(await errorOf(deletePurchase({ id: group.id }))).toBe(
      "This purchase has been converted to GST. Undo the GST conversion first, then delete it.",
    );
    expect(await owed(sup)).toEqual({ pure: 9.16, cash: 0 });

    await undoGSTPurchaseConversion(group.id);
    await deletePurchase({ id: group.id });
    expect(await owed(sup)).toEqual({ pure: 0, cash: 0 });
    expect(await stock(gold)).toBe(0);
  });

  it("11. direct (touch 0) item: valued weight × rate, must be kept in Cash", async () => {
    const sup = await makeSupplier("direct");
    const gold = await makeItem("GOLD", "direct");

    // Through the real API schema (touch 0 is accepted since the B12 fix, 2026-11-11).
    const direct = goldBill(sup, gold, "2", "0", "5000");

    expect(await errorOf(createPurchase({ ...direct, balance_mode: "PURE" }))).toBe(
      "Direct purchase items (touch 0) are valued in cash — set Maintain In to Cash",
    );

    // 2 g × ₹5000 = ₹10,000, no pure owed; 2 g still lands in stock.
    await createPurchase({ ...direct, balance_mode: "CASH" });
    expect(await owed(sup)).toEqual({ pure: 0, cash: 10000 });
    expect(await stock(gold)).toBe(2);
  });

  // Was B12 (fixed 2026-11-11): the frontend and createPurchase both support touch 0, but the
  // API schema's puritySchema required purity > 0, so the router rejected every direct purchase
  // before it reached the service. Purchase only — Sales still requires touch > 0 (owner).
  it("the purchase API accepts a direct (touch 0) item on a cash bill", () => {
    const input = (purity: string) => ({
      account_id: crypto.randomUUID(), // any valid uuid — only the shape is checked here
      date: DATE,
      rate_per_gram: "5000",
      gold_items: [{ item_id: crypto.randomUUID(), quantity: "2", purity }],
      balance_mode: "CASH",
    });
    // Control: the same input with a normal touch parses, so purity is the only difference.
    expect(CreatePurchaseSchema.safeParse(input("91.6")).success).toBe(true);
    const parsed = CreatePurchaseSchema.safeParse(input("0"));
    expect(parsed.success ? null : parsed.error.issues.map((i) => i.message)).toBeNull();
    // Still bounded to 0–100.
    expect(CreatePurchaseSchema.safeParse(input("-1")).success).toBe(false);
    expect(CreatePurchaseSchema.safeParse(input("100.01")).success).toBe(false);
    expect(CreatePurchaseSchema.safeParse(input("100")).success).toBe(true);
  });
});
