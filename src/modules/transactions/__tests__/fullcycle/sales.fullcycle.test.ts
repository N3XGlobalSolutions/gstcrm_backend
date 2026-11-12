import "@/__tests__/fullcycle/guard";
// Full-cycle integration test: SALES bills.
// Runs against a throwaway *_test Postgres DB only (the guard above refuses anything else).
//
//   FULLTEST_DB=gstcrm_ft_sales_test node scripts/fulltest/provision.mjs create
//   DATABASE_URL=<that db> bun test --timeout 120000 src/modules/transactions/__tests__/fullcycle/sales.fullcycle.test.ts
//
// Sign convention on a sales customer (raw ledger): positive = customer owes the shop.
//   - pure balance  = gold (pure grams) the customer still owes
//   - cash balance  = rupees the customer still owes (payments push it down)
//
// Every expected number below is worked out by hand from the business rules,
// with the arithmetic written next to it.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { accounts, entryGroups, items } from "@/db/schema";
import { getAccountLotBalances, getAggregateBalances, getBalance } from "@/lib/balance";
import { createEntryGroup } from "@/lib/entryBuilder";
import { SYSTEM_ACCOUNTS } from "@/config/constants";
import {
  convertCashToGold,
  convertGoldToCash,
  createSale,
  deleteSale,
  getSaleById,
  getSalePaymentStatus,
  listSales,
  settleSalePayment,
  updateSale,
} from "../../sales/service";
import { CreateSalesSchema, UpdateSalesSchema } from "../../sales/schema";

const RUN = `SALES-FT-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const DATE = "2026-11-10";
const USER = { id: "00000000-0000-0000-0000-0000000000aa", username: "fulltest_user" };
const SHOP = SYSTEM_ACCOUNTS.SHOP_ID;

let goldItemId: string; // plenty of stock (1000 g @ 91.6)
let smallGoldItemId: string; // only 5 g in stock — for the oversell guards
let editGoldItemId: string; // only 5 g in stock — for the "edit that oversells" case
let ornamentItemId: string;
let ornamentLotId: string; // one lot: 25 g, 5 pieces @ 91.6

// ─── helpers ──────────────────────────────────────────────────────────────────

function uniqueEntryNo() {
  // High range so we never collide with seeded entry numbers.
  return 800_000_000 + Math.floor(Math.random() * 100_000_000);
}

let customerSeq = 0;
async function newCustomer(label: string): Promise<string> {
  const [acc] = await db
    .insert(accounts)
    .values({
      entry_no: uniqueEntryNo(),
      name: `${RUN} Customer ${++customerSeq} ${label}`.slice(0, 100),
      type: "CUSTOMER",
      customer_type: "CUSTOMER",
    })
    .returning();
  return acc!.id;
}

async function newItem(label: string, type: "GOLD" | "ORNAMENT"): Promise<string> {
  const [item] = await db
    .insert(items)
    .values({
      entry_no: uniqueEntryNo(),
      name: `${RUN} ${label}`.slice(0, 100),
      type,
      unit: "GRAM",
      touch: "91.6",
    })
    .returning();
  return item!.id;
}

/** Puts opening stock into the shop, the same way stock.addOpeningStock does. */
async function addOpeningStock(itemId: string, quantity: string, pieceCount?: string) {
  const { entries } = await createEntryGroup({
    type: "OPENING",
    accountId: SYSTEM_ACCOUNTS.OPENING_STOCK_ID,
    date: DATE,
    entries: [
      {
        fromAccountId: SYSTEM_ACCOUNTS.OPENING_STOCK_ID,
        toAccountId: SHOP,
        itemId,
        quantity,
        purity: "91.6",
        pieceCount,
      },
    ],
  });
  return entries[0]!;
}

type Line = {
  item_id: string;
  quantity: string;
  purity?: string;
  lot_id?: string;
  wastage_value?: string;
  piece_count?: string;
};

function saleInput(
  accountId: string,
  lines: Line[],
  opts: {
    rate?: string;
    bank?: string;
    mode?: "PURE" | "CASH";
    discount?: string;
    tds?: string;
    tcs?: string;
  } = {},
) {
  return CreateSalesSchema.parse({
    account_id: accountId,
    date: DATE,
    rate_per_gram: opts.rate ?? "7000",
    remarks: RUN,
    items: lines.map((l) => ({
      item_id: l.item_id,
      lot_id: l.lot_id,
      quantity: l.quantity,
      purity: l.purity ?? "91.6",
      wastage_mode: "PERCENT",
      wastage_value: l.wastage_value ?? "0",
      piece_count: l.piece_count,
    })),
    bank_amount: opts.bank ?? "0",
    bank_details: opts.bank ? "Cash" : undefined,
    balance_mode: opts.mode ?? "PURE",
    discount: opts.discount ?? "0",
    tds_enabled: opts.tds !== undefined,
    tds_amount: opts.tds ?? "0",
    tcs_enabled: opts.tcs !== undefined,
    tcs_amount: opts.tcs ?? "0",
  });
}

const sell = (input: ReturnType<typeof saleInput>) => createSale(input, USER);
const editSale = (id: string, input: ReturnType<typeof saleInput>) =>
  updateSale(UpdateSalesSchema.parse({ ...input, id }), USER);

/** Customer balance as fixed strings: pure grams (3dp) and cash rupees (2dp). */
async function balanceOf(accountId: string) {
  const b = await getAggregateBalances(accountId);
  return { pure: b.totalPure.toFixed(3), cash: b.totalCash.toFixed(2) };
}

/** Shop's physical stock of an item, in grams (3dp). */
async function stockOf(itemId: string): Promise<string> {
  return (await getBalance(SHOP, itemId)).toFixed(3);
}

async function ornamentLot() {
  const lots = await getAccountLotBalances(SHOP, [ornamentItemId]);
  const lot = lots.find((l) => l.lot_id === ornamentLotId);
  return {
    grams: lot ? lot.quantity.toFixed(3) : "0.000",
    pieces: lot ? lot.pieces.toFixed(0) : "0",
  };
}

async function groupRow(id: string) {
  const [g] = await db.select().from(entryGroups).where(eq(entryGroups.id, id)).limit(1);
  return g!;
}

// bun's `expect(promise).rejects` hung on these DB-backed rejections, so capture
// the error by hand instead.
async function errorOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

// ─── setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  goldItemId = await newItem("Gold 916", "GOLD");
  smallGoldItemId = await newItem("Gold Small Stock", "GOLD");
  editGoldItemId = await newItem("Gold Edit Stock", "GOLD");
  ornamentItemId = await newItem("Ring", "ORNAMENT");

  await addOpeningStock(goldItemId, "1000");
  await addOpeningStock(smallGoldItemId, "5");
  await addOpeningStock(editGoldItemId, "5");
  const lotEntry = await addOpeningStock(ornamentItemId, "25", "5");
  ornamentLotId = lotEntry.lot_id!;
  expect(ornamentLotId).toBeTruthy();
});

afterAll(async () => {
  // Close the postgres pool so the test process can exit.
  await (db as unknown as { $client?: { end?: (o?: { timeout?: number }) => Promise<void> } }).$client?.end?.({ timeout: 5 });
});

// ─── tests ────────────────────────────────────────────────────────────────────

describe("Sales — full cycle", () => {
  it("1. credit sale of 10 g gold at touch 91.6: customer owes 9.160 g pure, shop stock drops 10 g", async () => {
    const customer = await newCustomer("credit");
    const stockBefore = Number(await stockOf(goldItemId));

    const sale = await sell(saleInput(customer, [{ item_id: goldItemId, quantity: "10" }], { rate: "7000" }));

    // 10 g × 91.6% = 9.160 g pure owed; nothing paid → cash 0
    expect(await balanceOf(customer)).toEqual({ pure: "9.160", cash: "0.00" });
    expect(await stockOf(goldItemId)).toBe((stockBefore - 10).toFixed(3));

    // First bill for this customer → bill no 1
    expect(sale.group.bill_no).toBe(1);
    expect(sale.group.type).toBe("SALE");

    // Bill value = 9.160 g × ₹7000 = ₹64,120.00, nothing paid yet
    const status = await getSalePaymentStatus({ id: sale.group.id });
    expect(status.currentCash).toBe(64120);
    expect(status.paid).toBe(0);
    expect(status.balance).toBe(64120);
  });

  it("2. paying a bill in parts: balance due drops, then reaches 0; over-paying is refused", async () => {
    const customer = await newCustomer("payments");
    const sale = await sell(saleInput(customer, [{ item_id: goldItemId, quantity: "10" }], { rate: "7000" }));
    const id = sale.group.id;
    // Bill value 9.160 × 7000 = 64,120

    // Paying more than what is due is refused, and nothing is recorded
    expect(await errorOf(settleSalePayment({ id, amount: "70000", method: "CASH" }))).toBe(
      "Payment cannot exceed the balance due (₹64120.00).",
    );
    expect((await getSalePaymentStatus({ id })).balance).toBe(64120);

    // Bank payment needs a bank chosen
    expect(await errorOf(settleSalePayment({ id, amount: "100", method: "BANK" }))).toBe("Select a bank account.");

    // Partial payment 20,000 → 44,120 still due
    const part = await settleSalePayment({ id, amount: "20000", method: "CASH" });
    expect(part.paid).toBe(20000);
    expect(part.balance).toBe(44120);
    // Customer ledger: still owes 9.160 g, and has paid ₹20,000 (raw cash -20,000)
    expect(await balanceOf(customer)).toEqual({ pure: "9.160", cash: "-20000.00" });

    // Remaining 44,120 by bank → fully settled
    const full = await settleSalePayment({ id, amount: "44120", method: "BANK", bank_details: "SBI 1234" });
    expect(full.paid).toBe(64120);
    expect(full.balance).toBe(0);
    expect(await balanceOf(customer)).toEqual({ pure: "9.160", cash: "-64120.00" });

    // Nothing left to pay → any further payment is refused
    expect(await errorOf(settleSalePayment({ id, amount: "1", method: "CASH" }))).toBe(
      "This bill is already fully paid.",
    );
  });

  it("3. cash-mode sale with payment, discount, TDS, TCS and round off: closing cash matches the bill math", async () => {
    const customer = await newCustomer("cash-mode");
    const stockBefore = Number(await stockOf(goldItemId));

    const sale = await sell(
      saleInput(customer, [{ item_id: goldItemId, quantity: "10" }], {
        mode: "CASH",
        rate: "7000",
        bank: "20000",
        discount: "500",
        tds: "64.12",
        tcs: "100.50",
      }),
    );

    // Bill value  = 10 g × 91.6% × 7000          = 64,120.00
    //  − paid 20,000 − discount 500 − TDS 64.12 + TCS 100.50 = 43,656.38
    //  round off to the whole rupee                = −0.38  → 43,656.00
    // Cash mode: the customer owes cash, not gold → pure stays 0
    expect(await balanceOf(customer)).toEqual({ pure: "0.000", cash: "43656.00" });
    expect(await stockOf(goldItemId)).toBe((stockBefore - 10).toFixed(3));

    const status = await getSalePaymentStatus({ id: sale.group.id });
    expect(status.currentCash).toBe(64120);
    // paid = 20,000 + 500 + 64.12 − 100.50 = 20,463.62
    expect(status.paid).toBe(20463.62);
    expect(status.balance).toBe(43656);

    // The round-off line is posted in the ledger (customer → shop, 0.38)
    const bill = await getSaleById({ id: sale.group.id });
    const roundOff = bill.entries.filter((e) => e.entry.remarks === "Round Off");
    expect(roundOff.length).toBe(1);
    expect(Number(roundOff[0]!.entry.quantity).toFixed(2)).toBe("0.38");
    expect(roundOff[0]!.entry.from_account_id).toBe(customer);
  });

  it("3b. cash-mode round off goes UP when the paise are 50 or more", async () => {
    const customer = await newCustomer("round-up");
    // 1 g × 91.6% × 7000 = 6,412.00; paid 1,000.25 → 5,411.75 → rounds up by 0.25 to 5,412.00
    await sell(saleInput(customer, [{ item_id: goldItemId, quantity: "1" }], { mode: "CASH", rate: "7000", bank: "1000.25" }));
    expect(await balanceOf(customer)).toEqual({ pure: "0.000", cash: "5412.00" });
  });

  it("3c. wastage is billed to the customer but only the physical weight leaves stock", async () => {
    const customer = await newCustomer("wastage");
    const stockBefore = Number(await stockOf(goldItemId));
    // 10 g @ 91.6 with 2% wastage → billed pure = 10 × (91.6 + 2)% = 9.360 g
    await sell(saleInput(customer, [{ item_id: goldItemId, quantity: "10", wastage_value: "2" }]));
    expect(await balanceOf(customer)).toEqual({ pure: "9.360", cash: "0.00" });
    expect(await stockOf(goldItemId)).toBe((stockBefore - 10).toFixed(3));
  });

  it("4. ornament sale from a lot reduces that lot's weight and pieces", async () => {
    const customer = await newCustomer("ornament");
    expect(await ornamentLot()).toEqual({ grams: "25.000", pieces: "5" });

    // Ornament without a lot is refused
    expect(
      await errorOf(sell(saleInput(customer, [{ item_id: ornamentItemId, quantity: "10", piece_count: "2" }]))),
    ).toStartWith("Lot ID is required for ornament");

    // More than the lot holds is refused
    expect(
      await errorOf(
        sell(saleInput(customer, [{ item_id: ornamentItemId, lot_id: ornamentLotId, quantity: "30", piece_count: "6" }])),
      ),
    ).toStartWith("Insufficient stock for ornament");

    await sell(saleInput(customer, [{ item_id: ornamentItemId, lot_id: ornamentLotId, quantity: "10", piece_count: "2" }]));

    // Lot: 25 g − 10 g = 15 g, 5 − 2 = 3 pieces; customer owes 10 × 91.6% = 9.160 g
    expect(await ornamentLot()).toEqual({ grams: "15.000", pieces: "3" });
    expect(await balanceOf(customer)).toEqual({ pure: "9.160", cash: "0.00" });
  });

  it("5. each bill's opening balance equals the previous bill's closing balance (3 bills)", async () => {
    const customer = await newCustomer("chain");

    // Bill A: 5 g @ 91.6, rate 7000, paid 10,000 → closing pure 4.580, cash −10,000
    const a = await sell(saleInput(customer, [{ item_id: goldItemId, quantity: "5" }], { rate: "7000", bank: "10000" }));
    // Bill B: 3 g @ 91.6, rate 7200, no payment → closing pure 4.580 + 2.748 = 7.328, cash −10,000
    const b = await sell(saleInput(customer, [{ item_id: goldItemId, quantity: "3" }], { rate: "7200" }));
    // Bill C (cash mode): 2 g @ 91.6 × 7000 = 12,824, paid 5,000
    //   → closing pure 7.328, cash −10,000 + 12,824 − 5,000 = −2,176
    const c = await sell(
      saleInput(customer, [{ item_id: goldItemId, quantity: "2" }], { mode: "CASH", rate: "7000", bank: "5000" }),
    );

    const opening = async (id: string) => {
      const bill = await getSaleById({ id });
      return { pure: Number(bill.openingPure).toFixed(3), cash: Number(bill.openingCash).toFixed(2) };
    };
    expect(await opening(a.group.id)).toEqual({ pure: "0.000", cash: "0.00" });
    expect(await opening(b.group.id)).toEqual({ pure: "4.580", cash: "-10000.00" });
    expect(await opening(c.group.id)).toEqual({ pure: "7.328", cash: "-10000.00" });
    expect(await balanceOf(customer)).toEqual({ pure: "7.328", cash: "-2176.00" });

    // Bill numbers run 1, 2, 3 for this customer
    expect([a.group.bill_no, b.group.bill_no, c.group.bill_no]).toEqual([1, 2, 3]);

    // The Sales History list shows the same openings
    const list = await listSales({ page: 1, limit: 100 });
    // listSales' type is a union (its empty-page early return has no openings), so narrow it.
    const rows = list.data as unknown as Array<{ group: { id: string }; openingPure: string; openingCash: string }>;
    const row = (id: string) => rows.find((d) => d.group.id === id)!;
    expect(row(a.group.id).openingPure).toBe("0.0000");
    expect(row(a.group.id).openingCash).toBe("0.00");
    expect(row(b.group.id).openingPure).toBe("4.5800");
    expect(row(b.group.id).openingCash).toBe("-10000.00");
    expect(row(c.group.id).openingPure).toBe("7.3280");
    expect(row(c.group.id).openingCash).toBe("-10000.00");
  });

  it("6. gold→cash and cash→gold conversion move the balance between gold and cash", async () => {
    const customer = await newCustomer("convert");
    // Nothing owed yet → nothing to convert
    expect(await errorOf(convertGoldToCash({ account_id: customer, gold_grams: "1", rate_per_gram: "7000" }))).toBe(
      "This customer has no outstanding gold balance to convert.",
    );

    await sell(saleInput(customer, [{ item_id: goldItemId, quantity: "10" }], { rate: "7000" }));
    expect(await balanceOf(customer)).toEqual({ pure: "9.160", cash: "0.00" });

    // Gold → cash: 2 g @ 7000 → pure 9.160 − 2 = 7.160, cash +14,000
    const g2c = await convertGoldToCash({ account_id: customer, gold_grams: "2", rate_per_gram: "7000" });
    expect(g2c.group.bill_no).toBeNull(); // bookkeeping, not a bill
    expect(await balanceOf(customer)).toEqual({ pure: "7.160", cash: "14000.00" });

    // Cash → gold: ₹3,500 @ 7000 = 0.5 g → cash 14,000 − 3,500 = 10,500, pure 7.160 + 0.5 = 7.660
    await convertCashToGold({ account_id: customer, cash_amount: "3500", rate_per_gram: "7000" });
    expect(await balanceOf(customer)).toEqual({ pure: "7.660", cash: "10500.00" });

    // Converting more than is owed is refused, balance untouched
    expect(await errorOf(convertGoldToCash({ account_id: customer, gold_grams: "8", rate_per_gram: "7000" }))).toBe(
      "Cannot convert 8.000g — only 7.660g of gold is outstanding for this customer.",
    );
    expect(await errorOf(convertCashToGold({ account_id: customer, cash_amount: "20000", rate_per_gram: "7000" }))).toBe(
      "Cannot convert ₹20000.00 — only ₹10500.00 of cash is outstanding for this customer.",
    );
    expect(await balanceOf(customer)).toEqual({ pure: "7.660", cash: "10500.00" });

    // Conversions don't touch stock or the next bill number
    const next = await sell(saleInput(customer, [{ item_id: goldItemId, quantity: "1" }]));
    expect(next.group.bill_no).toBe(2);
  });

  // BUG: deleteGuards.ts says conversion entries "never stand in the way of a delete",
  // but assertDeletableLastBill picks the "latest" bill with ORDER BY bill_no DESC
  // (src/lib/deleteGuards.ts:80). Conversions are SALE groups with bill_no NULL, and
  // Postgres sorts NULLs FIRST in DESC order — so the conversion is taken as the
  // latest bill and the real last bill can no longer be deleted
  // ("Only this party's most recent sale can be deleted…"). Needs NULLS LAST.
  // Skipped: owner 2026-11-11 — bills are not deleted in practice (B7 not fixed).
  it.skip("BUG: a customer's latest real bill can still be deleted after a gold→cash conversion", async () => {
    const customer = await newCustomer("convert-then-delete");
    const stockBefore = Number(await stockOf(goldItemId));
    const sale = await sell(saleInput(customer, [{ item_id: goldItemId, quantity: "10" }], { rate: "7000" }));
    await convertGoldToCash({ account_id: customer, gold_grams: "2", rate_per_gram: "7000" });

    expect(await errorOf(deleteSale({ id: sale.group.id }, USER))).toBeNull();
    // Only the conversion is left: pure −2, cash +14,000; stock fully back
    expect(await balanceOf(customer)).toEqual({ pure: "-2.000", cash: "14000.00" });
    expect(await stockOf(goldItemId)).toBe(stockBefore.toFixed(3));
  });

  it("7. editing the latest bill reverses the old entries; balance and stock reflect only the new version", async () => {
    const customer = await newCustomer("edit");
    const stockBefore = Number(await stockOf(goldItemId));

    const v0 = await sell(saleInput(customer, [{ item_id: goldItemId, quantity: "10" }], { rate: "7000", bank: "5000" }));
    expect(await balanceOf(customer)).toEqual({ pure: "9.160", cash: "-5000.00" });

    // Edit: 6 g @ touch 92, rate 7100, paid 2,000
    const v1 = await editSale(
      v0.group.id,
      saleInput(customer, [{ item_id: goldItemId, quantity: "6", purity: "92" }], { rate: "7100", bank: "2000" }),
    );

    // Old version reversed and hidden; new one keeps bill no / entry no
    const old = await groupRow(v0.group.id);
    expect(old.is_deleted).toBe(true);
    expect(old.reversed_by).not.toBeNull();
    const rev = await groupRow(old.reversed_by!);
    expect(rev.type).toBe("REVERSAL");
    expect(rev.reversal_of).toBe(v0.group.id);
    expect(v1.group.id).not.toBe(v0.group.id);
    expect(v1.group.bill_no).toBe(v0.group.bill_no);
    expect(v1.group.entry_no).toBe(v0.group.entry_no);

    // 6 g × 92% = 5.520 g; paid 2,000 → cash −2,000; stock only loses 6 g
    expect(await balanceOf(customer)).toEqual({ pure: "5.520", cash: "-2000.00" });
    expect(await stockOf(goldItemId)).toBe((stockBefore - 6).toFixed(3));

    // Bill status of the new version: 5.520 × 7100 = 39,192 − 2,000 = 37,192
    const status = await getSalePaymentStatus({ id: v1.group.id });
    expect(status.currentCash).toBe(39192);
    expect(status.balance).toBe(37192);

    // The old version can't be edited again
    expect(
      await errorOf(editSale(v0.group.id, saleInput(customer, [{ item_id: goldItemId, quantity: "1" }]))),
    ).toBe("Transaction already reversed");

    // Once a newer bill exists, the older one can't be edited
    await sell(saleInput(customer, [{ item_id: goldItemId, quantity: "1" }]));
    expect(
      await errorOf(editSale(v1.group.id, saleInput(customer, [{ item_id: goldItemId, quantity: "2" }]))),
    ).toBe("Only the most recent sale bill for this customer can be edited.");
    // 5.520 + 0.916 = 6.436
    expect(await balanceOf(customer)).toEqual({ pure: "6.436", cash: "-2000.00" });
  });

  it("8. deleting bills (latest first) puts balance and stock back to where they were", async () => {
    const customer = await newCustomer("delete");
    const stockBefore = Number(await stockOf(goldItemId));

    const first = await sell(saleInput(customer, [{ item_id: goldItemId, quantity: "4" }], { bank: "1000" }));
    const second = await sell(saleInput(customer, [{ item_id: goldItemId, quantity: "3" }]));
    // 4 × 0.916 + 3 × 0.916 = 3.664 + 2.748 = 6.412
    expect(await balanceOf(customer)).toEqual({ pure: "6.412", cash: "-1000.00" });
    expect(await stockOf(goldItemId)).toBe((stockBefore - 7).toFixed(3));

    // An older bill can't be deleted while a newer one exists
    expect(await errorOf(deleteSale({ id: first.group.id }, USER))).toBe(
      "Only this party's most recent sale can be deleted. Delete the later sales first.",
    );

    await deleteSale({ id: second.group.id }, USER);
    expect(await balanceOf(customer)).toEqual({ pure: "3.664", cash: "-1000.00" });
    expect(await stockOf(goldItemId)).toBe((stockBefore - 4).toFixed(3));

    await deleteSale({ id: first.group.id }, USER);
    expect(await balanceOf(customer)).toEqual({ pure: "0.000", cash: "0.00" });
    expect(await stockOf(goldItemId)).toBe(stockBefore.toFixed(3));

    // Deleted twice → refused
    expect(await errorOf(deleteSale({ id: first.group.id }, USER))).toBe("This sale is already deleted.");
    // Deleted bill is gone from lookups
    expect(await errorOf(getSaleById({ id: first.group.id }))).toBe("Sale not found");
  });

  it("9. selling more gold than is in stock is blocked (also when split over several lines)", async () => {
    const customer = await newCustomer("oversell");
    expect(await stockOf(smallGoldItemId)).toBe("5.000");

    expect(await errorOf(sell(saleInput(customer, [{ item_id: smallGoldItemId, quantity: "6" }])))).toBe(
      `Insufficient stock for item ${RUN} Gold Small Stock. Available: 5.000g, Required: 6.000g`,
    );
    // 3 g + 3 g = 6 g on two lines of the same item is also more than 5 g
    expect(
      await errorOf(
        sell(
          saleInput(customer, [
            { item_id: smallGoldItemId, quantity: "3" },
            { item_id: smallGoldItemId, quantity: "3" },
          ]),
        ),
      ),
    ).toStartWith("Insufficient stock for item");

    // Nothing was written
    expect(await balanceOf(customer)).toEqual({ pure: "0.000", cash: "0.00" });
    expect(await stockOf(smallGoldItemId)).toBe("5.000");

    // Exactly what's in stock is fine
    await sell(saleInput(customer, [{ item_id: smallGoldItemId, quantity: "5" }]));
    expect(await stockOf(smallGoldItemId)).toBe("0.000");
    expect(await balanceOf(customer)).toEqual({ pure: "4.580", cash: "0.00" });
  });

  // Was B1: updateSale reversed the original bill in its OWN committed transaction and
  // only then called createSale, so a refused edit (here: not enough stock) left the
  // bill reversed and gone. Fixed 2026-11-11: the reversal now runs inside createSale's
  // save transaction (reverseGroupId), so both commit or roll back together.
  it("an edit that would oversell is refused and the original bill stays as it was", async () => {
    const customer = await newCustomer("edit-oversell");
    const v0 = await sell(saleInput(customer, [{ item_id: editGoldItemId, quantity: "4" }]));
    // 5 g stock − 4 g sold = 1 g left; 4 × 0.916 = 3.664 owed
    expect(await stockOf(editGoldItemId)).toBe("1.000");

    // Editing to 7 g: only 5 g could ever be available (1 g + the bill's own 4 g)
    const err = await errorOf(editSale(v0.group.id, saleInput(customer, [{ item_id: editGoldItemId, quantity: "7" }])));
    expect(err).toStartWith("Insufficient stock for item");

    // The original bill must be untouched
    const g = await groupRow(v0.group.id);
    expect(g.is_deleted).toBe(false);
    expect(g.reversed_by).toBeNull();
    // … and no stray REVERSAL group was left behind for it.
    expect(await db.select().from(entryGroups).where(eq(entryGroups.reversal_of, v0.group.id))).toEqual([]);
    expect(await balanceOf(customer)).toEqual({ pure: "3.664", cash: "0.00" });
    expect(await stockOf(editGoldItemId)).toBe("1.000");

    // A valid edit afterwards still works: 5 g (1 g left + the bill's own 4 g) → stock 0.
    const v1 = await editSale(v0.group.id, saleInput(customer, [{ item_id: editGoldItemId, quantity: "5" }]));
    expect(v1.group.bill_no).toBe(v0.group.bill_no);
    expect(await stockOf(editGoldItemId)).toBe("0.000");
    expect(await balanceOf(customer)).toEqual({ pure: "4.580", cash: "0.00" });
  });

  it("9c. a payment larger than the bill at creation is accepted and leaves the customer in credit", async () => {
    // service.ts: "Overpayment guard removed by request" — bank_amount is not capped at bill time.
    const customer = await newCustomer("overpay-at-create");
    // 1 g × 0.916 × 7000 = 6,412 bill; paid 10,000 → bill balance −3,588
    const sale = await sell(saleInput(customer, [{ item_id: goldItemId, quantity: "1" }], { bank: "10000" }));
    expect(await balanceOf(customer)).toEqual({ pure: "0.916", cash: "-10000.00" });
    expect((await getSalePaymentStatus({ id: sale.group.id })).balance).toBe(-3588);
    // …and the Pay popup has nothing more to take
    expect(await errorOf(settleSalePayment({ id: sale.group.id, amount: "1", method: "CASH" }))).toBe(
      "This bill is already fully paid.",
    );
  });
});
