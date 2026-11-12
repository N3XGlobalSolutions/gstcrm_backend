import "@/__tests__/fullcycle/guard";
// Full-cycle integration test: LABOUR BILL + ISSUE & JOB WORKS.
// Runs against a throwaway "*_test" Postgres database only (guard above).
//
//   FULLTEST_DB=gstcrm_ft_labour_test node scripts/fulltest/provision.mjs create
//   DATABASE_URL=<that db> bun test --timeout 120000 \
//     src/modules/transactions/__tests__/fullcycle/labourJobWork.fullcycle.test.ts
//
// Balance sign (raw ledger): positive = the party owes the shop.
// Editing old/latest bills is covered by labourBill.edit.test.ts and
// jobWork.edit.test.ts — not repeated here.
//
// Not tested because gstcrm does not have them (they exist only in goldcrm):
// wages ₹/g × net weight, the Job Works "Alloy (g)" column, ornament piece
// counts on labour/job-work rows, and the "no GST/TDS/TCS when the bill has
// Gold Receipt rows" rule.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { accounts, entries, entryGroups, items, jobWorkCycles } from "@/db/schema";
import { getAggregateBalances, getBalance } from "@/lib/balance";
import { createEntryGroup } from "@/lib/entryBuilder";
import { SYSTEM_ACCOUNTS, SYSTEM_ITEMS } from "@/config/constants";
import * as lb from "../../labourBill/service";
import * as jw from "../../jobWork/service";
import { JOB_WORK_TOUCH_NEEDED_MESSAGE } from "../../jobWork/touch";
import { getDetailedReport } from "@/modules/reports/service";

const RUN = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
const DATE = "2026-11-10";
const SHOP = SYSTEM_ACCOUNTS.SHOP_ID;

// ─── helpers ──────────────────────────────────────────────────────────────────

function uniqueEntryNo() {
  return 700_000_000 + Math.floor(Math.random() * 100_000_000);
}

async function errorOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

let seq = 0;
async function makeParty(label: string): Promise<string> {
  const [acc] = await db
    .insert(accounts)
    .values({
      entry_no: uniqueEntryNo(),
      name: `FT-LJ ${label} ${++seq} ${RUN}`,
      type: "GOLDSMITH",
      customer_type: "GOLD_SMITH",
    })
    .returning();
  return acc!.id;
}

async function makeItem(label: string, type: "GOLD" | "ORNAMENT", touch: string) {
  const [item] = await db
    .insert(items)
    .values({
      entry_no: uniqueEntryNo(),
      name: `FT-LJ ${label} ${RUN}`.slice(0, 100),
      type,
      unit: "GRAM",
      touch,
    })
    .returning();
  return item!.id;
}

/** Opening stock into SHOP — same shape as stock.addOpeningStock. */
async function openingStock(itemId: string, qty: string, purity: string) {
  await createEntryGroup({
    type: "OPENING",
    accountId: SYSTEM_ACCOUNTS.OPENING_STOCK_ID,
    date: DATE,
    entries: [
      { fromAccountId: SYSTEM_ACCOUNTS.OPENING_STOCK_ID, toAccountId: SHOP, itemId, quantity: qty, purity },
    ],
  });
}

/** Shop stock of an item in grams (physical weight). */
async function stock(itemId: string): Promise<string> {
  return (await getBalance(SHOP, itemId)).toFixed(3);
}

/** Shop stock of an item in pure grams. */
async function stockPure(itemId: string): Promise<string> {
  const rows = await db.execute<{ p: string }>(sql`
    SELECT (COALESCE(SUM(CASE WHEN to_account_id = ${SHOP} THEN pure_quantity ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN from_account_id = ${SHOP} THEN pure_quantity ELSE 0 END), 0))::text AS p
    FROM entries WHERE item_id = ${itemId} AND (to_account_id = ${SHOP} OR from_account_id = ${SHOP})`);
  return Number(rows[0]!.p).toFixed(3);
}

async function bal(accountId: string) {
  const b = await getAggregateBalances(accountId);
  return { pure: b.totalPure.toFixed(3), cash: b.totalCash.toFixed(2) };
}

async function groupRow(id: string) {
  const [g] = await db.select().from(entryGroups).where(eq(entryGroups.id, id)).limit(1);
  return g!;
}

async function entriesOf(groupId: string) {
  return db.select().from(entries).where(eq(entries.group_id, groupId));
}

const pause = () => Bun.sleep(30); // distinct created_at between bills

type GoldRow = { item_id: string; quantity: string; purity: string };
type OrnRow = GoldRow & { wastage_percent: string };

function labourInput(
  accountId: string,
  cycleId: string,
  rows: Partial<{
    gold_issue: GoldRow[];
    gold_receipt: GoldRow[];
    ornament_issue: OrnRow[];
    ornament_receipt: OrnRow[];
  }>,
  extra: Record<string, unknown> = {},
) {
  return {
    account_id: accountId,
    bill_cycle_id: cycleId,
    date: DATE,
    rate_per_gram: "6000",
    gold_issue: rows.gold_issue ?? [],
    gold_receipt: rows.gold_receipt ?? [],
    ornament_issue: rows.ornament_issue ?? [],
    ornament_receipt: rows.ornament_receipt ?? [],
    cash_conversions: [] as { gold_grams: string; rate_per_gram: string; cash_amount: string }[],
    ...extra,
  };
}

function jobInput(
  accountId: string,
  cycleId: string,
  rows: Partial<{ gold_issue: GoldRow[]; gold_receipt: GoldRow[] }>,
  extra: Record<string, unknown> = {},
) {
  return {
    account_id: accountId,
    bill_cycle_id: cycleId,
    date: DATE,
    rate_per_gram: "6000",
    gold_issue: rows.gold_issue ?? [],
    gold_receipt: rows.gold_receipt ?? [],
    ornament_issue: [] as OrnRow[],
    ornament_receipt: [] as OrnRow[],
    cash_conversions: [] as { gold_grams: string; rate_per_gram: string; cash_amount: string }[],
    ...extra,
  };
}

// ─── setup ────────────────────────────────────────────────────────────────────

let gold: string; // GOLD item, 100 g @ 92 opening stock
let orn: string; // ORNAMENT item, 50 g @ 92 opening stock
let jwGold: string; // GOLD item for job works, 100 g @ 92 opening stock

beforeAll(async () => {
  gold = await makeItem("Gold", "GOLD", "92");
  orn = await makeItem("Ornament", "ORNAMENT", "92");
  jwGold = await makeItem("JW Gold", "GOLD", "92");
  await openingStock(gold, "100", "92");
  await openingStock(orn, "50", "92");
  await openingStock(jwGold, "100", "92");
});

afterAll(async () => {
  await (db as unknown as { $client?: { end?: (o?: { timeout?: number }) => Promise<void> } }).$client?.end?.({ timeout: 5 });
});

// ═════════════════════════════════════════════════════════════════════════════
// LABOUR BILL
// ═════════════════════════════════════════════════════════════════════════════

describe("Labour Bill", () => {
  it("1. gold issue: goldsmith owes the pure, shop stock goes down; gold receipt brings both back", async () => {
    const gs = await makeParty("LB1");
    const cycle = await lb.createCycle({ account_id: gs, main_reason: "gold issue/receipt" });
    const stock0 = Number(await stock(gold));

    // Issue 20 g @ 92 → goldsmith owes 18.4 pure
    const issue = await lb.createLabourBill(labourInput(gs, cycle.id, {
      gold_issue: [{ item_id: gold, quantity: "20", purity: "92" }],
    }));
    expect(await bal(gs)).toEqual({ pure: "18.400", cash: "0.00" });
    expect(await stock(gold)).toBe((stock0 - 20).toFixed(3));
    const [issueEntry] = await entriesOf(issue.group.id);
    expect(issueEntry!.from_account_id).toBe(SHOP);
    expect(issueEntry!.to_account_id).toBe(gs);
    expect(Number(issueEntry!.pure_quantity).toFixed(3)).toBe("18.400");

    await pause();
    // Receipt 15 g @ 91.6 → 13.74 pure comes back; 18.4 − 13.74 = 4.66 still owed
    await lb.createLabourBill(labourInput(gs, cycle.id, {
      gold_receipt: [{ item_id: gold, quantity: "15", purity: "91.6" }],
    }));
    expect(await bal(gs)).toEqual({ pure: "4.660", cash: "0.00" });
    expect(await stock(gold)).toBe((stock0 - 20 + 15).toFixed(3));
  });

  it("2. ornament issue and receipt with wastage: balance carries wastage, stock moves by physical weight", async () => {
    // (gstcrm Labour Bill rows have no piece count — see header.)
    const gs = await makeParty("LB2");
    const cycle = await lb.createCycle({ account_id: gs });
    const stock0 = Number(await stock(orn));

    // Issue 10 g @ 92 with 2 % wastage:
    //   wastage = 10 × 0.02 / 0.92 = 0.217 g ; pure = (10 + 0.217) × 0.92 = 9.4
    const issue = await lb.createLabourBill(labourInput(gs, cycle.id, {
      ornament_issue: [{ item_id: orn, quantity: "10", purity: "92", wastage_percent: "2" }],
    }));
    const [ie] = await entriesOf(issue.group.id);
    expect(Number(ie!.quantity)).toBe(10);
    expect(Number(ie!.wastage_quantity).toFixed(3)).toBe("0.217");
    expect(Number(ie!.pure_quantity).toFixed(3)).toBe("9.400");
    expect(await bal(gs)).toEqual({ pure: "9.400", cash: "0.00" });
    expect(await stock(orn)).toBe((stock0 - 10).toFixed(3));

    await pause();
    // Receipt 8 g @ 92 with 5 % wastage: pure = 8 × 0.92 + 8 × 0.05 = 7.76
    const rec = await lb.createLabourBill(labourInput(gs, cycle.id, {
      ornament_receipt: [{ item_id: orn, quantity: "8", purity: "92", wastage_percent: "5" }],
    }));
    const [re] = await entriesOf(rec.group.id);
    expect(re!.from_account_id).toBe(gs);
    expect(re!.to_account_id).toBe(SHOP);
    expect(Number(re!.pure_quantity).toFixed(3)).toBe("7.760");
    // 9.4 − 7.76 = 1.64 pure still owed; stock back up by the physical 8 g
    expect(await bal(gs)).toEqual({ pure: "1.640", cash: "0.00" });
    expect(await stock(orn)).toBe((stock0 - 10 + 8).toFixed(3));
  });

  it("3. bill posts under the chosen bill cycle; new cycles number 1, 2, 3 per goldsmith", async () => {
    const gs = await makeParty("LB3");
    const other = await makeParty("LB3-other");
    const c1 = await lb.createCycle({ account_id: gs, main_reason: "Ring" });
    const c2 = await lb.createCycle({ account_id: gs, main_reason: "Chain" });
    const oc = await lb.createCycle({ account_id: other });
    expect(c1.bill_no).toBe(1);
    expect(c2.bill_no).toBe(2);
    expect(oc.bill_no).toBe(1); // numbering is per goldsmith
    expect(c1.main_reason).toBe("Ring");

    const listed = await lb.listCycles({ account_id: gs });
    expect(listed.map((c) => c.bill_no)).toEqual([2, 1]);

    const a = await lb.createLabourBill(labourInput(gs, c1.id, {
      gold_issue: [{ item_id: gold, quantity: "1", purity: "92" }],
    }));
    await pause();
    const b = await lb.createLabourBill(labourInput(gs, c2.id, {
      gold_issue: [{ item_id: gold, quantity: "1", purity: "92" }],
    }));
    await pause();
    const c = await lb.createLabourBill(labourInput(gs, c1.id, {
      gold_issue: [{ item_id: gold, quantity: "1", purity: "92" }],
    }));
    expect(a.group.bill_no).toBe(1);
    expect(a.group.bill_cycle_id).toBe(c1.id);
    expect(b.group.bill_no).toBe(2);
    expect(b.group.bill_cycle_id).toBe(c2.id);
    expect(c.group.bill_no).toBe(1); // same cycle → same bill no
    expect(a.group.entry_no).not.toBe(c.group.entry_no);

    const d1 = await lb.getCycleDetail({ cycle_id: c1.id });
    expect(d1.groups.map((g) => g.group.id)).toEqual([a.group.id, c.group.id]);
    const d2 = await lb.getCycleDetail({ cycle_id: c2.id });
    expect(d2.groups.map((g) => g.group.id)).toEqual([b.group.id]);

    // A third cycle continues the numbering
    const c3 = await lb.createCycle({ account_id: gs });
    expect(c3.bill_no).toBe(3);

    // Another goldsmith's cycle is refused, nothing saved
    expect(
      await errorOf(lb.createLabourBill(labourInput(gs, oc.id, {
        gold_issue: [{ item_id: gold, quantity: "1", purity: "92" }],
      }))),
    ).toBe("Selected bill cycle belongs to a different goldsmith.");
    // A cycle id that does not exist is refused
    expect(
      await errorOf(lb.createLabourBill(labourInput(gs, "00000000-0000-4000-8000-00000000dead", {
        gold_issue: [{ item_id: gold, quantity: "1", purity: "92" }],
      }))),
    ).toBe("Selected bill cycle does not exist.");
    expect((await bal(gs)).pure).toBe("2.760"); // 3 × 0.92
  });

  it("4. cash on the slip: bank paid raises what the goldsmith owes, bank receive lowers it; rate is stored", async () => {
    // (gstcrm has no wages ₹/g column — see header. This checks the cash that IS posted.)
    const gs = await makeParty("LB4");
    const cycle = await lb.createCycle({ account_id: gs });
    const bill = await lb.createLabourBill(labourInput(gs, cycle.id, {
      gold_issue: [{ item_id: gold, quantity: "10", purity: "92" }],
    }, { rate_per_gram: "6500", bank_paid: "5000", bank_paid_details: "HDFC", bank_receive: "2000" }));

    expect(Number(bill.group.rate_per_gram)).toBe(6500);
    // 5000 advance − 2000 repaid = 3000 owed in cash, 9.2 pure in gold
    expect(await bal(gs)).toEqual({ pure: "9.200", cash: "3000.00" });

    const money = (await entriesOf(bill.group.id)).filter((e) => e.item_id === SYSTEM_ITEMS.RUPEE_ITEM_ID);
    const paid = money.find((e) => e.to_account_id === gs)!;
    const recv = money.find((e) => e.from_account_id === gs)!;
    expect(Number(paid.quantity)).toBe(5000);
    expect(paid.remarks).toBe("HDFC");
    expect(Number(recv.quantity)).toBe(2000);

    // Rate/Gm is mandatory and must be > 0
    expect(
      await errorOf(lb.createLabourBill(labourInput(gs, cycle.id, {
        gold_issue: [{ item_id: gold, quantity: "1", purity: "92" }],
      }, { rate_per_gram: "0" }))),
    ).not.toBeNull();
    // A bill with nothing on it is refused
    expect(await errorOf(lb.createLabourBill(labourInput(gs, cycle.id, {})))).toBe(
      "Labour bill must have at least one entry",
    );
  });

  it("5. TDS / TCS amounts are stored on the bill", async () => {
    // gstcrm has no "no GST/TDS on Gold Receipt bills" rule (goldcrm only) — see header.
    const gs = await makeParty("LB5");
    const cycle = await lb.createCycle({ account_id: gs });
    const bill = await lb.createLabourBill(labourInput(gs, cycle.id, {
      gold_issue: [{ item_id: gold, quantity: "10", purity: "92" }],
    }, { tds_enabled: true, tds_amount: "53.59", tcs_enabled: true, tcs_amount: "10.00" }));
    const g = await groupRow(bill.group.id);
    expect(Number(g.tds_amount)).toBe(53.59);
    expect(Number(g.tcs_amount)).toBe(10);
    const money = (await entriesOf(bill.group.id)).filter((e) => e.item_id === SYSTEM_ITEMS.RUPEE_ITEM_ID);
    expect(money.map((e) => e.remarks).sort()).toEqual(["TCS Adjustment", "TDS Adjustment"]);

    // tds_amount without tds_enabled posts nothing
    const gs2 = await makeParty("LB5b");
    const cyc2 = await lb.createCycle({ account_id: gs2 });
    await lb.createLabourBill(labourInput(gs2, cyc2.id, {
      gold_issue: [{ item_id: gold, quantity: "1", purity: "92" }],
    }, { tds_enabled: false, tds_amount: "5" }));
    expect((await bal(gs2)).cash).toBe("0.00");
  });

  // B2 (fixed 2026-11-11): the Labour Bill slip (LabourBillContext:
  // cashOut = bankReceive + discount + tds − tcs) lowers what the goldsmith owes
  // by Discount and TDS and raises it by TCS; the server used to post them the
  // other way round.
  it("5b. discount and TDS lower what the goldsmith owes, TCS raises it", async () => {
    const gs = await makeParty("LB5c");
    const cycle = await lb.createCycle({ account_id: gs });
    const bill = await lb.createLabourBill(labourInput(gs, cycle.id, {
      gold_issue: [{ item_id: gold, quantity: "1", purity: "92" }],
    }, {
      bank_paid: "1000",
      discount: "100",
      tds_enabled: true, tds_amount: "50",
      tcs_enabled: true, tcs_amount: "20",
    }));
    // 1000 advance − 100 discount − 50 TDS + 20 TCS = 870 owed
    expect((await bal(gs)).cash).toBe("870.00");

    // Directions: Discount / TDS goldsmith → SHOP, TCS SHOP → goldsmith
    const money = (await entriesOf(bill.group.id)).filter((e) => e.item_id === SYSTEM_ITEMS.RUPEE_ITEM_ID);
    const byRemark = (r: string) => money.find((e) => e.remarks === r)!;
    expect(byRemark("Discount")).toMatchObject({ from_account_id: gs, to_account_id: SHOP });
    expect(byRemark("TDS Adjustment")).toMatchObject({ from_account_id: gs, to_account_id: SHOP });
    expect(byRemark("TCS Adjustment")).toMatchObject({ from_account_id: SHOP, to_account_id: gs });

    // Each on its own, against the slip formula
    const gs2 = await makeParty("LB5d");
    const c2 = await lb.createCycle({ account_id: gs2 });
    await lb.createLabourBill(labourInput(gs2, c2.id, {
      gold_issue: [{ item_id: gold, quantity: "1", purity: "92" }],
    }, { bank_paid: "500", discount: "120" }));
    expect((await bal(gs2)).cash).toBe("380.00"); // 500 − 120
    await pause();
    await lb.createLabourBill(labourInput(gs2, c2.id, {
      gold_issue: [{ item_id: gold, quantity: "1", purity: "92" }],
    }, { tcs_enabled: true, tcs_amount: "30" }));
    expect((await bal(gs2)).cash).toBe("410.00"); // + 30 TCS

    // Edit round trip: saving the same bill again keeps the balance
    const view = await lb.getLabourBillById({ id: bill.group.id });
    expect(view).toBeTruthy();
    await lb.updateLabourBill({
      id: bill.group.id,
      ...labourInput(gs, cycle.id, {
        gold_issue: [{ item_id: gold, quantity: "1", purity: "92" }],
      }, {
        bank_paid: "1000",
        discount: "100",
        tds_enabled: true, tds_amount: "50",
        tcs_enabled: true, tcs_amount: "20",
      }),
    });
    expect(await bal(gs)).toEqual({ pure: "0.920", cash: "870.00" });
  });

  it("6. Convert gold → cash, cash → gold and Receive Cash move the balance (no bill number used)", async () => {
    const gs = await makeParty("LB6");
    const cycle = await lb.createCycle({ account_id: gs });
    await lb.createLabourBill(labourInput(gs, cycle.id, {
      gold_issue: [{ item_id: gold, quantity: "10", purity: "92" }],
    }));
    expect(await bal(gs)).toEqual({ pure: "9.200", cash: "0.00" });
    const stockBefore = await stock(gold);

    // 2 g pure → ₹12,000 cash debt
    const conv = await lb.convertGoldToCash({ account_id: gs, gold_grams: "2", rate_per_gram: "6000" });
    expect(conv.group.bill_no).toBeNull();
    expect(await bal(gs)).toEqual({ pure: "7.200", cash: "12000.00" });

    // Receive ₹5,000 → cash owed 7,000
    const rc = await lb.receiveCash({ account_id: gs, amount: "5000", date: DATE, details: "Cash" });
    expect(rc.group.bill_no).toBeNull();
    expect(rc.group.bill_cycle_id).toBeNull();
    expect(await bal(gs)).toEqual({ pure: "7.200", cash: "7000.00" });

    // ₹6,000 → 1 g pure back onto the gold side
    await lb.convertCashToGold({ account_id: gs, cash_amount: "6000", rate_per_gram: "6000" });
    expect(await bal(gs)).toEqual({ pure: "8.200", cash: "1000.00" });

    // Cannot convert more than is outstanding
    expect(
      await errorOf(lb.convertGoldToCash({ account_id: gs, gold_grams: "9", rate_per_gram: "6000" })),
    ).toContain("Cannot convert 9.000g");
    expect(
      await errorOf(lb.convertCashToGold({ account_id: gs, cash_amount: "1500", rate_per_gram: "6000" })),
    ).toContain("Cannot convert ₹1500.00");

    // None of this touches shop stock
    expect(await stock(gold)).toBe(stockBefore);
  });

  // B4 (fixed 2026-11-11): an in-bill "Cash Conversion" (cash_conversions[]) used
  // to post one RUPEE entry goldsmith → SHOP — lowering the cash debt and leaving
  // the gold untouched. The slip (LabourBillContext: slipBalancePure −= gold_grams,
  // cashIn += cash_amount) and the stand-alone convertGoldToCash move the gold
  // into a cash debt.
  it("6b. in-bill cash conversion moves pure gold into a cash debt", async () => {
    const gs = await makeParty("LB6b");
    const cycle = await lb.createCycle({ account_id: gs });
    const s0 = await stock(gold);
    const bill = await lb.createLabourBill({
      ...labourInput(gs, cycle.id, { gold_issue: [{ item_id: gold, quantity: "10", purity: "92" }] }),
      cash_conversions: [{ gold_grams: "2", rate_per_gram: "6000", cash_amount: "12000" }],
    });
    // 9.2 − 2 = 7.2 pure owed, 2 × 6000 = 12,000 cash owed
    expect(await bal(gs)).toEqual({ pure: "7.200", cash: "12000.00" });
    // Only the 10 g issue touches stock
    expect(await stock(gold)).toBe((Number(s0) - 10).toFixed(3));

    // Two RUPEE lines, like convertGoldToCash: gold side goldsmith → SHOP (pure 2,
    // no weight), cash side SHOP → goldsmith (₹12,000)
    const conv = (await entriesOf(bill.group.id)).filter((e) => (e.remarks ?? "").startsWith("Cash conversion:"));
    expect(conv).toHaveLength(2);
    const goldSide = conv.find((e) => Number(e.quantity) === 0)!;
    const cashSide = conv.find((e) => Number(e.quantity) > 0)!;
    expect(goldSide).toMatchObject({ from_account_id: gs, to_account_id: SHOP, item_id: SYSTEM_ITEMS.RUPEE_ITEM_ID });
    expect(Number(goldSide.pure_quantity)).toBe(2);
    expect(cashSide).toMatchObject({ from_account_id: SHOP, to_account_id: gs, item_id: SYSTEM_ITEMS.RUPEE_ITEM_ID });
    expect(Number(cashSide.quantity)).toBe(12000);
    expect(cashSide.remarks).toBe("Cash conversion: 2g @ ₹6000/g");

    // Detailed report counts the converted grams and cash once
    const det = await getDetailedReport({ type: "LABOUR_BILL", from_date: DATE, to_date: DATE, account_id: gs });
    expect(det.bills).toHaveLength(1);
    expect(det.bills[0]).toMatchObject({ conversion_pure: 2, conversion_cash: 12000, cash_paid: 0, cash_received: 0 });

    // Edit round trip keeps the balance; the next bill opens on it
    await lb.updateLabourBill({
      id: bill.group.id,
      ...labourInput(gs, cycle.id, { gold_issue: [{ item_id: gold, quantity: "10", purity: "92" }] }),
      cash_conversions: [{ gold_grams: "2", rate_per_gram: "6000", cash_amount: "12000" }],
    });
    expect(await bal(gs)).toEqual({ pure: "7.200", cash: "12000.00" });
    await pause();
    const next = await lb.createLabourBill(labourInput(gs, cycle.id, {
      gold_receipt: [{ item_id: gold, quantity: "1", purity: "92" }],
    }));
    const vn = await lb.getLabourBillById({ id: next.group.id });
    expect(Number(vn.openingPure).toFixed(3)).toBe("7.200");
    expect(Number(vn.openingCash).toFixed(2)).toBe("12000.00");
  });

  it("7. running balance over 3 bills; deleting the latest restores balance and stock", async () => {
    const gs = await makeParty("LB7");
    const cycle = await lb.createCycle({ account_id: gs });
    const s0 = Number(await stock(gold));

    const a = await lb.createLabourBill(labourInput(gs, cycle.id, {
      gold_issue: [{ item_id: gold, quantity: "10", purity: "92" }],
    }, { bank_paid: "1000" }));
    await pause();
    const b = await lb.createLabourBill(labourInput(gs, cycle.id, {
      gold_issue: [{ item_id: gold, quantity: "5", purity: "92" }],
    }));
    await pause();
    const c = await lb.createLabourBill(labourInput(gs, cycle.id, {
      gold_receipt: [{ item_id: gold, quantity: "8", purity: "92" }],
    }, { bank_receive: "500" }));

    // Openings chain: A 0/0 → B 9.2/1000 → C 13.8/1000 → closing 6.44/500
    const va = await lb.getLabourBillById({ id: a.group.id });
    const vb = await lb.getLabourBillById({ id: b.group.id });
    const vc = await lb.getLabourBillById({ id: c.group.id });
    expect(Number(va.openingPure)).toBe(0);
    expect(Number(vb.openingPure).toFixed(3)).toBe("9.200");
    expect(Number(vb.openingCash).toFixed(2)).toBe("1000.00");
    expect(Number(vc.openingPure).toFixed(3)).toBe("13.800");
    expect(Number(vc.openingCash).toFixed(2)).toBe("1000.00");
    expect(await bal(gs)).toEqual({ pure: "6.440", cash: "500.00" });
    expect(await stock(gold)).toBe((s0 - 10 - 5 + 8).toFixed(3));

    // Only the latest can be deleted
    expect(await errorOf(lb.deleteLabourBill({ id: a.group.id }))).toContain("most recent labour bill");

    await lb.deleteLabourBill({ id: c.group.id });
    const gc = await groupRow(c.group.id);
    expect(gc.is_deleted).toBe(true);
    expect(gc.reversed_by).not.toBeNull();
    expect(await bal(gs)).toEqual({ pure: "13.800", cash: "1000.00" });
    expect(await stock(gold)).toBe((s0 - 15).toFixed(3));
    expect(await errorOf(lb.getLabourBillById({ id: c.group.id }))).toBe("Labour bill not found");

    // Now B is the latest → deletable
    await lb.deleteLabourBill({ id: b.group.id });
    expect(await bal(gs)).toEqual({ pure: "9.200", cash: "1000.00" });
    expect(await stock(gold)).toBe((s0 - 10).toFixed(3));
  });

  // BUG: Receive Cash / Convert entries are LABOUR_BILL groups with bill_no NULL.
  // assertDeletableLastBill orders by bill_no DESC, and Postgres puts NULLs FIRST
  // in DESC order, so a Receive Cash posted after a bill becomes the "latest bill"
  // and blocks deleting the real last bill (its own comment says conversion
  // entries "never stand in the way of a delete"). Suspect: src/lib/deleteGuards.ts
  // (latest-bill query: orderBy(desc(entryGroups.bill_no), ...)).
  // Skipped: owner 2026-11-11 — bills are not deleted in practice (B7/B8 not fixed).
  it.skip("BUG: 7b. a Receive Cash after the last bill does not block deleting that bill", async () => {
    const gs = await makeParty("LB7b");
    const cycle = await lb.createCycle({ account_id: gs });
    const a = await lb.createLabourBill(labourInput(gs, cycle.id, {
      gold_issue: [{ item_id: gold, quantity: "10", purity: "92" }],
    }));
    await pause();
    await lb.receiveCash({ account_id: gs, amount: "100", date: DATE });
    expect(await errorOf(lb.deleteLabourBill({ id: a.group.id }))).toBeNull();
  });

  // BUG: the delete guard picks "latest" by bill_no (= cycle number) before time.
  // A bill posted later into an OLDER cycle cannot be deleted, while an earlier
  // bill in a newer cycle can — deleting it from the middle of the timeline
  // rewrites the opening of the later bill. Suspect: src/lib/deleteGuards.ts
  // (orderBy(desc(entryGroups.bill_no), desc(entryGroups.created_at))).
  // Skipped: owner 2026-11-11 — bills are not deleted in practice (B7/B8 not fixed).
  it.skip("BUG: 7c. the most recent bill can be deleted even when it sits in an older cycle", async () => {
    const gs = await makeParty("LB7c");
    const c1 = await lb.createCycle({ account_id: gs });
    const c2 = await lb.createCycle({ account_id: gs });
    const early = await lb.createLabourBill(labourInput(gs, c2.id, {
      gold_issue: [{ item_id: gold, quantity: "1", purity: "92" }],
    }));
    await pause();
    const late = await lb.createLabourBill(labourInput(gs, c1.id, {
      gold_issue: [{ item_id: gold, quantity: "2", purity: "92" }],
    }));
    // The most recent bill (cycle 1) → allowed
    expect(await errorOf(lb.deleteLabourBill({ id: late.group.id }))).toBeNull();
    // The earlier bill (cycle 2) is the last one now → allowed too
    expect(await errorOf(lb.deleteLabourBill({ id: early.group.id }))).toBeNull();
    expect((await bal(gs)).pure).toBe("0.000");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// ISSUE & JOB WORKS (employee Bill Cycle + Required Touch)
// ═════════════════════════════════════════════════════════════════════════════

describe("Issue & Job Works", () => {
  it("8. gold issue to employee and receipt back: balance and stock", async () => {
    // (gstcrm job-work rows have no Alloy (g) column — see header.)
    const emp = await makeParty("JW8");
    const cycle = await jw.createCycle({ account_id: emp, main_reason: "Bangles", required_touch: "91.6" });
    expect(cycle.bill_no).toBe(1);
    expect(Number(cycle.required_touch)).toBe(91.6);
    const s0 = Number(await stock(jwGold));

    // Issue 20 g @ 92 → employee owes 18.4 pure
    const issue = await jw.createJobWork(jobInput(emp, cycle.id, {
      gold_issue: [{ item_id: jwGold, quantity: "20", purity: "92" }],
    }));
    expect(issue.group.type).toBe("JOB_WORK");
    expect(issue.group.job_work_cycle_id).toBe(cycle.id);
    expect(issue.group.bill_cycle_id).toBeNull();
    expect(issue.group.bill_no).toBe(1);
    expect(await bal(emp)).toEqual({ pure: "18.400", cash: "0.00" });
    expect(await stock(jwGold)).toBe((s0 - 20).toFixed(3));

    await pause();
    // Receipt 12 g @ 91.6 → 10.992 pure back; 18.4 − 10.992 = 7.408 owed
    await jw.createJobWork(jobInput(emp, cycle.id, {
      gold_receipt: [{ item_id: jwGold, quantity: "12", purity: "91.6" }],
    }));
    expect(await bal(emp)).toEqual({ pure: "7.408", cash: "0.00" });
    expect(await stock(jwGold)).toBe((s0 - 20 + 12).toFixed(3));

    const detail = await jw.getCycleDetail({ cycle_id: cycle.id });
    expect(detail.groups.length).toBe(2);
    const c2 = await jw.createCycle({ account_id: emp });
    expect(c2.bill_no).toBe(2);
    expect(c2.required_touch).toBeNull();
  });

  it("9. receipt below the cycle's Required Touch still saves (warning only); stock uses the typed touch", async () => {
    const emp = await makeParty("JW9");
    const cycle = await jw.createCycle({ account_id: emp, required_touch: "92" });
    const pure0 = Number(await stockPure(jwGold));
    const s0 = Number(await stock(jwGold));

    // 10 g received at 90 touch — below the cycle's 92
    const rec = await jw.createJobWork(jobInput(emp, cycle.id, {
      gold_receipt: [{ item_id: jwGold, quantity: "10", purity: "90" }],
    }));
    const [e] = await entriesOf(rec.group.id);
    expect(Number(e!.purity)).toBe(90);
    expect(Number(e!.pure_quantity).toFixed(3)).toBe("9.000");
    expect(await stock(jwGold)).toBe((s0 + 10).toFixed(3));
    expect(await stockPure(jwGold)).toBe((pure0 + 9).toFixed(3));
    expect(await bal(emp)).toEqual({ pure: "-9.000", cash: "0.00" });

    // The cycle's stored touch is unchanged
    const [cyc] = await db.select().from(jobWorkCycles).where(eq(jobWorkCycles.id, cycle.id));
    expect(Number(cyc!.required_touch)).toBe(92);

    // A touch typed on the bill updates the cycle
    await pause();
    await jw.createJobWork(jobInput(emp, cycle.id, {
      gold_receipt: [{ item_id: jwGold, quantity: "1", purity: "91" }],
    }, { required_touch: "91.5" }));
    const [cyc2] = await db.select().from(jobWorkCycles).where(eq(jobWorkCycles.id, cycle.id));
    expect(Number(cyc2!.required_touch)).toBe(91.5);

    // A receipt with no touch anywhere (cycle has none, bill gives none) is refused
    const noTouch = await jw.createCycle({ account_id: emp });
    expect(
      await errorOf(jw.createJobWork(jobInput(emp, noTouch.id, {
        gold_receipt: [{ item_id: jwGold, quantity: "1", purity: "92" }],
      }))),
    ).toBe(JOB_WORK_TOUCH_NEEDED_MESSAGE);
    // An issue-only bill on that cycle needs no touch
    expect(
      await errorOf(jw.createJobWork(jobInput(emp, noTouch.id, {
        gold_issue: [{ item_id: jwGold, quantity: "1", purity: "92" }],
      }))),
    ).toBeNull();
  });

  it("10. TDS on a job work is stored on the bill", async () => {
    // (gstcrm has no wages ₹/g column — see header. TDS is sent as a fixed ₹ amount.)
    const emp = await makeParty("JW10");
    const cycle = await jw.createCycle({ account_id: emp, required_touch: "92" });
    const bill = await jw.createJobWork(jobInput(emp, cycle.id, {
      gold_issue: [{ item_id: jwGold, quantity: "10", purity: "92" }],
    }, { tds_enabled: true, tds_amount: "53.59" }));
    const g = await groupRow(bill.group.id);
    expect(Number(g.tds_amount)).toBe(53.59);
    const tds = (await entriesOf(bill.group.id)).filter((e) => e.remarks === "TDS Adjustment");
    expect(tds.length).toBe(1);
    expect(Number(tds[0]!.quantity)).toBe(53.59);
    expect((await bal(emp)).pure).toBe("9.200");
  });

  // B3 (checked 2026-11-11): the Issue & Job Works slip is NOT the Labour Bill
  // slip. It shows the balance from the shop's side (IssueJobWorksContext:
  // opening = −raw, positive = the shop owes the employee) and
  //   cash = slipPure × rate + conversionCash + bankReceive − (bankPaid + discount + tds − tcs).
  // So TDS / Discount lower what the SHOP owes the employee (raw +) and TCS
  // raises it (raw −) — what the server already posts. The old expectation (950)
  // used the Labour Bill formula. Bank Paid ₹1,000 + TDS ₹50 → slip −1,050 → raw +1,050.
  it("10b. job-work TDS / Discount / TCS follow the Job Works slip", async () => {
    const emp = await makeParty("JW10b");
    const cycle = await jw.createCycle({ account_id: emp });
    const bill = await jw.createJobWork(jobInput(emp, cycle.id, {
      gold_issue: [{ item_id: jwGold, quantity: "1", purity: "92" }],
    }, { bank_paid: "1000", tds_enabled: true, tds_amount: "50" }));
    expect((await bal(emp)).cash).toBe("1050.00");
    const tds = (await entriesOf(bill.group.id)).find((e) => e.remarks === "TDS Adjustment")!;
    expect(tds).toMatchObject({ from_account_id: SHOP, to_account_id: emp });

    // Bank Receive ₹2,000, Discount ₹100, TCS ₹30 on a receipt slip:
    // slip cash = 2000 − 100 + 30 = +1,930 (shop owes) → raw −1,930
    const emp2 = await makeParty("JW10c");
    const c2 = await jw.createCycle({ account_id: emp2, required_touch: "92" });
    const b2 = await jw.createJobWork(jobInput(emp2, c2.id, {
      gold_receipt: [{ item_id: jwGold, quantity: "1", purity: "92" }],
    }, { bank_receive: "2000", discount: "100", tcs_enabled: true, tcs_amount: "30" }));
    expect(await bal(emp2)).toEqual({ pure: "-0.920", cash: "-1930.00" });
    const money = await entriesOf(b2.group.id);
    expect(money.find((e) => e.remarks === "Discount")).toMatchObject({ from_account_id: SHOP, to_account_id: emp2 });
    expect(money.find((e) => e.remarks === "TCS Adjustment")).toMatchObject({ from_account_id: emp2, to_account_id: SHOP });
  });

  // B4 for Job Works (fixed 2026-11-11): the in-bill conversion used to post only
  // the cash line. The slip (IssueJobWorksContext, display = −raw) takes the
  // grams off the gold the shop owes and adds the cash the shop owes:
  // slipBalancePure −= grams, cashIn += cash → raw pure + grams, raw cash − cash.
  it("10d. job-work in-bill cash conversion moves the gold the shop owes into cash", async () => {
    const emp = await makeParty("JW10d");
    const cycle = await jw.createCycle({ account_id: emp, required_touch: "92" });
    const s0 = Number(await stock(jwGold));
    // Receipt 10 g @ 92 → shop owes 9.2 pure (raw −9.2); convert 3 g @ ₹6,000
    const bill = await jw.createJobWork({
      ...jobInput(emp, cycle.id, { gold_receipt: [{ item_id: jwGold, quantity: "10", purity: "92" }] }),
      cash_conversions: [{ gold_grams: "3", rate_per_gram: "6000", cash_amount: "18000" }],
    });
    // Slip: pure 9.2 − 3 = 6.2 owed by shop, cash 18,000 owed by shop
    expect(await bal(emp)).toEqual({ pure: "-6.200", cash: "-18000.00" });
    expect(await stock(jwGold)).toBe((s0 + 10).toFixed(3));

    const conv = (await entriesOf(bill.group.id)).filter((e) => (e.remarks ?? "").startsWith("Cash conversion:"));
    expect(conv).toHaveLength(2);
    expect(conv.find((e) => Number(e.quantity) === 0)).toMatchObject({ from_account_id: SHOP, to_account_id: emp });
    expect(conv.find((e) => Number(e.quantity) > 0)).toMatchObject({ from_account_id: emp, to_account_id: SHOP });

    const det = await getDetailedReport({ type: "JOB_WORK", from_date: DATE, to_date: DATE, account_id: emp });
    expect(det.bills[0]).toMatchObject({ conversion_pure: 3, conversion_cash: 18000 });

    // Edit round trip keeps the balance
    await jw.updateJobWork({
      id: bill.group.id,
      ...jobInput(emp, cycle.id, { gold_receipt: [{ item_id: jwGold, quantity: "10", purity: "92" }] }),
      cash_conversions: [{ gold_grams: "3", rate_per_gram: "6000", cash_amount: "18000" }],
    });
    expect(await bal(emp)).toEqual({ pure: "-6.200", cash: "-18000.00" });
  });

  it("11. running balance over 3 job works; deleting the latest restores balance and stock", async () => {
    const emp = await makeParty("JW11");
    const cycle = await jw.createCycle({ account_id: emp, required_touch: "91.6" });
    const s0 = Number(await stock(jwGold));

    const a = await jw.createJobWork(jobInput(emp, cycle.id, {
      gold_issue: [{ item_id: jwGold, quantity: "30", purity: "92" }],
    }, { bank_paid: "2000" }));
    await pause();
    const b = await jw.createJobWork(jobInput(emp, cycle.id, {
      gold_receipt: [{ item_id: jwGold, quantity: "10", purity: "91.6" }],
    }));
    await pause();
    const c = await jw.createJobWork(jobInput(emp, cycle.id, {
      gold_receipt: [{ item_id: jwGold, quantity: "5", purity: "92" }],
    }, { bank_receive: "1500" }));

    // A: +27.6 pure, +2000 → B: −9.16 → C: −4.6, −1500
    const vb = await jw.getJobWorkById({ id: b.group.id });
    const vc = await jw.getJobWorkById({ id: c.group.id });
    expect(Number((await jw.getJobWorkById({ id: a.group.id })).openingPure)).toBe(0);
    expect(Number(vb.openingPure).toFixed(3)).toBe("27.600");
    expect(Number(vb.openingCash).toFixed(2)).toBe("2000.00");
    expect(Number(vc.openingPure).toFixed(3)).toBe("18.440");
    expect(await bal(emp)).toEqual({ pure: "13.840", cash: "500.00" });
    expect(await stock(jwGold)).toBe((s0 - 30 + 10 + 5).toFixed(3));

    // List view shows the same openings
    const list = await jw.listJobWork({ page: 1, limit: 100 });
    const row = list.data.find((d) => d.group.id === c.group.id)!;
    expect(Number(row.openingPure).toFixed(3)).toBe("18.440");

    expect(await errorOf(jw.deleteJobWork({ id: a.group.id }))).toContain("most recent job work");

    await jw.deleteJobWork({ id: c.group.id });
    expect((await groupRow(c.group.id)).is_deleted).toBe(true);
    expect(await bal(emp)).toEqual({ pure: "18.440", cash: "2000.00" });
    expect(await stock(jwGold)).toBe((s0 - 30 + 10).toFixed(3));
    expect(await errorOf(jw.getJobWorkById({ id: c.group.id }))).toBe("Job work not found");
    // Deleting twice is refused
    expect(await errorOf(jw.deleteJobWork({ id: c.group.id }))).toContain("already deleted");

    // A labour-bill delete cannot remove a job work
    expect(await errorOf(lb.deleteLabourBill({ id: b.group.id }))).toBe("This entry is not a labour bill.");
    await jw.deleteJobWork({ id: b.group.id });
    expect(await bal(emp)).toEqual({ pure: "27.600", cash: "2000.00" });
    expect(await stock(jwGold)).toBe((s0 - 30).toFixed(3));

    // Nothing left on the cycle but A
    const live = await db.select().from(entryGroups).where(and(
      eq(entryGroups.job_work_cycle_id, cycle.id),
      eq(entryGroups.is_deleted, false),
    ));
    expect(live.map((g) => g.id)).toEqual([a.group.id]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// READ-ONLY AUDIT of bills saved before the 2026-11-11 direction fix
// (scripts/audit-labour-direction.mjs). Old-style rows are written straight
// through createEntryGroup, exactly as the old service code posted them.
// ═════════════════════════════════════════════════════════════════════════════

type AuditFinding = {
  bill_type: string; entry_no: number; account_id: string; entry: string;
  amount: number; cash_off: number; pure_off: number;
};
type AuditTotal = {
  account_id: string; bills: number; cash_off: number; pure_off: number;
  ledger_cash_now: number; ledger_pure_now: number; cash_corrected: number; pure_corrected: number;
};

function runAudit(): { database: string; findings: AuditFinding[]; totals: AuditTotal[] } {
  const script = `${import.meta.dir}/../../../../../scripts/audit-labour-direction.mjs`;
  const out = Bun.spawnSync(["node", script, "--json"], { env: { ...process.env } });
  if (out.exitCode !== 0) throw new Error(`audit failed: ${out.stderr.toString()}`);
  return JSON.parse(out.stdout.toString());
}

describe("Audit script: old-direction Labour Bill / Job Work lines", () => {
  it("12. lists old Discount / TDS / TCS / conversion lines with the amount each party is off; ignores new bills", async () => {
    // Old-style Labour Bill: 10 g @ 92 issued, Bank Paid 1000, Discount 100,
    // TDS 50, TCS 20 and a 2 g @ 6000 conversion — as the old code posted them.
    const gs = await makeParty("AUD-LB");
    const cyc = await lb.createCycle({ account_id: gs });
    const oldLb = await createEntryGroup({
      type: "LABOUR_BILL", accountId: gs, date: DATE, billNo: cyc.bill_no, billCycleId: cyc.id,
      ratePerGram: "6000", tdsAmount: "50", tcsAmount: "20",
      entries: [
        { fromAccountId: SHOP, toAccountId: gs, itemId: gold, quantity: "10", purity: "92" },
        { fromAccountId: SHOP, toAccountId: gs, itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID, quantity: "1000", remarks: "HDFC" },
        { fromAccountId: SHOP, toAccountId: gs, itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID, quantity: "100", remarks: "Discount" },
        { fromAccountId: SHOP, toAccountId: gs, itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID, quantity: "50", remarks: "TDS Adjustment" },
        { fromAccountId: gs, toAccountId: SHOP, itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID, quantity: "20", remarks: "TCS Adjustment" },
        { fromAccountId: gs, toAccountId: SHOP, itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID, quantity: "12000", remarks: "Cash conversion: 2g @ ₹6000/g" },
      ],
    });
    // Ledger now: pure 9.2; cash 1000 + 100 + 50 − 20 − 12000 = −10,870
    expect(await bal(gs)).toEqual({ pure: "9.200", cash: "-10870.00" });

    // Old-style Job Work: 10 g @ 92 received, 3 g @ 6000 conversion with the cash
    // line only, and a TDS line (already the right way for Job Works → not listed).
    const emp = await makeParty("AUD-JW");
    const jcyc = await jw.createCycle({ account_id: emp, required_touch: "92" });
    const oldJw = await createEntryGroup({
      type: "JOB_WORK", accountId: emp, date: DATE, billNo: jcyc.bill_no, jobWorkCycleId: jcyc.id,
      ratePerGram: "6000", tdsAmount: "40",
      entries: [
        { fromAccountId: emp, toAccountId: SHOP, itemId: jwGold, quantity: "10", purity: "92" },
        { fromAccountId: emp, toAccountId: SHOP, itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID, quantity: "18000", remarks: "Cash conversion: 3g @ ₹6000/g" },
        { fromAccountId: SHOP, toAccountId: emp, itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID, quantity: "40", remarks: "TDS Adjustment" },
      ],
    });

    // New-style bills through today's services — must not be listed.
    const ok = await makeParty("AUD-OK");
    const okCyc = await lb.createCycle({ account_id: ok });
    await lb.createLabourBill({
      ...labourInput(ok, okCyc.id, { gold_issue: [{ item_id: gold, quantity: "10", purity: "92" }] }, {
        bank_paid: "1000", discount: "100", tds_enabled: true, tds_amount: "50", tcs_enabled: true, tcs_amount: "20",
      }),
      cash_conversions: [{ gold_grams: "2", rate_per_gram: "6000", cash_amount: "12000" }],
    });
    const okEmp = await makeParty("AUD-OK-JW");
    const okJc = await jw.createCycle({ account_id: okEmp, required_touch: "92" });
    await jw.createJobWork({
      ...jobInput(okEmp, okJc.id, { gold_receipt: [{ item_id: jwGold, quantity: "10", purity: "92" }] }, {
        discount: "10", tds_enabled: true, tds_amount: "40", tcs_enabled: true, tcs_amount: "5",
      }),
      cash_conversions: [{ gold_grams: "3", rate_per_gram: "6000", cash_amount: "18000" }],
    });
    // An old-style bill that was since edited (soft-deleted + reversed) is not listed either.
    const edited = await makeParty("AUD-EDIT");
    const eCyc = await lb.createCycle({ account_id: edited });
    const oldEdited = await createEntryGroup({
      type: "LABOUR_BILL", accountId: edited, date: DATE, billNo: eCyc.bill_no, billCycleId: eCyc.id, ratePerGram: "6000",
      entries: [
        { fromAccountId: SHOP, toAccountId: edited, itemId: gold, quantity: "1", purity: "92" },
        { fromAccountId: SHOP, toAccountId: edited, itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID, quantity: "100", remarks: "Discount" },
      ],
    });
    await lb.updateLabourBill({
      id: oldEdited.group.id,
      ...labourInput(edited, eCyc.id, { gold_issue: [{ item_id: gold, quantity: "1", purity: "92" }] }, { discount: "100" }),
    });
    expect((await bal(edited)).cash).toBe("-100.00");

    const before = await db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM entries`);
    const audit = runAudit();
    const after = await db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM entries`);
    expect(after[0]!.n).toBe(before[0]!.n); // read-only
    expect(audit.database.endsWith("_test")).toBe(true);

    for (const party of [ok, okEmp, edited]) {
      expect(audit.findings.filter((f) => f.account_id === party)).toEqual([]);
    }

    const lbRows = audit.findings.filter((f) => f.account_id === gs);
    expect(lbRows.every((f) => f.bill_type === "LABOUR_BILL" && f.entry_no === oldLb.group.entry_no)).toBe(true);
    const lbBy = (prefix: string) => lbRows.find((f) => f.entry.startsWith(prefix))!;
    expect(lbRows).toHaveLength(4);
    expect(lbBy("Discount")).toMatchObject({ amount: 100, cash_off: 200, pure_off: 0 });
    expect(lbBy("TDS Adjustment")).toMatchObject({ amount: 50, cash_off: 100, pure_off: 0 });
    expect(lbBy("TCS Adjustment")).toMatchObject({ amount: 20, cash_off: -40, pure_off: 0 });
    expect(lbBy("In-bill conversion")).toMatchObject({ amount: 12000, cash_off: -24000, pure_off: 2 });

    // Corrected = what the slip showed: pure 9.2 − 2 = 7.2;
    // cash 12000 + 1000 − 100 − 50 + 20 = 12,870
    const lbTotal = audit.totals.find((t) => t.account_id === gs)!;
    expect(lbTotal).toMatchObject({
      bills: 1, cash_off: -23740, pure_off: 2,
      ledger_cash_now: -10870, ledger_pure_now: 9.2, cash_corrected: 12870, pure_corrected: 7.2,
    });

    const jwRows = audit.findings.filter((f) => f.account_id === emp);
    expect(jwRows).toHaveLength(1);
    expect(jwRows[0]).toMatchObject({
      bill_type: "JOB_WORK", entry_no: oldJw.group.entry_no, amount: 18000, cash_off: 0, pure_off: -3,
    });
    // Job Works slip: shop owes 9.2 − 3 = 6.2 pure → raw −6.2
    expect(audit.totals.find((t) => t.account_id === emp)).toMatchObject({
      pure_off: -3, ledger_pure_now: -9.2, pure_corrected: -6.2,
    });
  });
});
