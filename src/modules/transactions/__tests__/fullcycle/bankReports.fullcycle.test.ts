import "@/__tests__/fullcycle/guard";
// Full-cycle integration test: BANK balances and REPORTS matching the bills.
// Runs against a throwaway *_test Postgres DB only (the guard above refuses anything else).
//
//   FULLTEST_DB=gstcrm_ft_reports_test node scripts/fulltest/provision.mjs create
//   DATABASE_URL=<that db> bun test --timeout 120000 src/modules/transactions/__tests__/fullcycle/bankReports.fullcycle.test.ts
//
// Date plan (so the tests never see each other's bills):
//   2025-12 ......... opening stock (before the report range)
//   2026-01 ......... the "report" bills: 2 sales + 2 purchases, all paid through Bank R
//   2026-02 ......... Customer Balance report bills (sales customer, supplier, goldsmith)
//   2026-03 ......... bank test 2 bills (Bank C) — later deleted
//   2026-04 ......... cash-mode-with-wastage sale (own customer, filtered by account)
//   2026-05 ......... manual deposits / withdrawals / transfers (Banks A and B)
//   2026-06 ......... bank test 2d: a sale paid into Bank C, then edited
//
// Every expected number is worked out by hand next to the assertion.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@/db";
import { accounts, items } from "@/db/schema";
import { SYSTEM_ACCOUNTS } from "@/config/constants";
import { createEntryGroup } from "@/lib/entryBuilder";
import {
  addBankFunds,
  getBankLedger,
  listBanks,
  saveBanks,
  type BankAccountConfig,
  type BankTransaction,
} from "@/modules/bank/service";
import { BankLedgerSchema } from "@/modules/bank/schema";
import {
  getBankReport,
  getDetailedReport,
  getStockReport,
  getTransactionReport,
} from "@/modules/reports/service";
import { getCustomerBalanceReport } from "@/modules/reports/customerBalance";
import { convertGoldToCash, createSale, deleteSale, settleSalePayment, updateSale } from "../../sales/service";
import { ConvertGoldToCashSchema, CreateSalesSchema, UpdateSalesSchema } from "../../sales/schema";
import { createPurchase, deletePurchase } from "../../purchase/service";
import { CreatePurchaseSchema } from "../../purchase/schema";
import { createExpense } from "../../expense/service";
import { createCycle, createLabourBill, receiveCash } from "../../labourBill/service";
import { transferBankFunds } from "@/modules/bank/service";

const RUN = `RPT-FT-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const USER = { id: "00000000-0000-0000-0000-0000000000aa", username: "fulltest_user" };
const SHOP = SYSTEM_ACCOUNTS.SHOP_ID;

// ─── helpers ──────────────────────────────────────────────────────────────────

function uniqueEntryNo() {
  return 800_000_000 + Math.floor(Math.random() * 100_000_000);
}

let accSeq = 0;
async function newAccount(
  label: string,
  type: "CUSTOMER" | "GOLDSMITH",
  customerType: "CUSTOMER" | "PURCHASER" | "GOLD_SMITH",
): Promise<string> {
  const [acc] = await db
    .insert(accounts)
    .values({
      entry_no: uniqueEntryNo(),
      name: `${RUN} ${++accSeq} ${label}`.slice(0, 100),
      type,
      customer_type: customerType,
    })
    .returning();
  return acc!.id;
}

async function newGoldItem(label: string, touch: string): Promise<string> {
  const [item] = await db
    .insert(items)
    .values({ entry_no: uniqueEntryNo(), name: `${RUN} ${label}`.slice(0, 100), type: "GOLD", unit: "GRAM", touch })
    .returning();
  return item!.id;
}

function sale(input: Record<string, unknown>) {
  return createSale(CreateSalesSchema.parse(input), USER);
}
function editSale(input: Record<string, unknown>) {
  return updateSale(UpdateSalesSchema.parse(input), USER);
}
function purchase(input: Record<string, unknown>) {
  return createPurchase(CreatePurchaseSchema.parse(input));
}
function ledger(input: Record<string, unknown>) {
  return getBankLedger(BankLedgerSchema.parse({ limit: 100, ...input }));
}

// ─── shared fixtures ──────────────────────────────────────────────────────────

let gold: string; // GOLD item, everything at touch 91.6
let lbGold: string; // GOLD item used only by the goldsmith (touch 92)
let bankA: BankAccountConfig; // manual moves only, opening 10000
let bankB: BankAccountConfig; // manual moves only, opening 5000
let bankC: BankAccountConfig; // bill payments that later get deleted, opening 0
let bankR: BankAccountConfig; // the January report bills, opening 1000

// January report bills
let cus1: string;
let sup1: string;
const jan = {} as Record<"S1" | "S2" | "P1" | "P2", string>;

beforeAll(async () => {
  gold = await newGoldItem("Gold 91.6", "91.6");
  lbGold = await newGoldItem("LB Gold 92", "92");

  // This DB is ours alone, so the company's bank list can be replaced outright.
  const banks = await saveBanks({
    banks: [
      { bankName: `RPT Bank A ${RUN}`, accountNo: "11110001", ifscCode: "AAAA0000001", branch: "", openingBalance: "10000" },
      { bankName: `RPT Bank B ${RUN}`, accountNo: "22220002", ifscCode: "BBBB0000002", branch: "", openingBalance: "5000" },
      { bankName: `RPT Bank C ${RUN}`, accountNo: "33330003", ifscCode: "CCCC0000003", branch: "", openingBalance: "0" },
      { bankName: `RPT Bank R ${RUN}`, accountNo: "44440004", ifscCode: "RRRR0000004", branch: "", openingBalance: "1000" },
    ],
  });
  [bankA, bankB, bankC, bankR] = banks as [BankAccountConfig, BankAccountConfig, BankAccountConfig, BankAccountConfig];
  expect(bankR.label).toBe(`RPT Bank R ${RUN} - A/C: 44440004 (RRRR0000004)`);

  // Opening stock 2025-12-15 (before the January range): 500 g @ 91.6 = 458 pure.
  await createEntryGroup({
    type: "OPENING",
    accountId: SYSTEM_ACCOUNTS.OPENING_STOCK_ID,
    date: "2025-12-15",
    remarks: "Opening stock",
    entries: [
      { fromAccountId: SYSTEM_ACCOUNTS.OPENING_STOCK_ID, toAccountId: SHOP, itemId: gold, quantity: "500", purity: "91.6" },
    ],
  });

  // ── The January report bills (all payments through Bank R) ─────────────────
  cus1 = await newAccount("Jan Customer", "CUSTOMER", "CUSTOMER");
  sup1 = await newAccount("Jan Supplier", "CUSTOMER", "PURCHASER");

  // P1 2026-01-05 PURE: 100 g @ 91.6 = 91.6 pure × 6000 = 549600.
  //   bank 10000 (R), discount 500, TDS 100.
  jan.P1 = (
    await purchase({
      account_id: sup1, date: "2026-01-05", rate_per_gram: "6000",
      gold_items: [{ item_id: gold, quantity: "100", purity: "91.6" }],
      bank_amount: "10000", bank_details: bankR.label, discount: "500",
      tds_enabled: true, tds_amount: "100",
    })
  ).group.id;

  // S1 2026-01-10 PURE: 20 g @ 91.6, no wastage = 18.32 pure × 6200 = 113584.
  //   bank 50000 (R), discount 1000, TCS 300.
  jan.S1 = (
    await sale({
      account_id: cus1, date: "2026-01-10", rate_per_gram: "6200",
      items: [{ item_id: gold, quantity: "20", purity: "91.6", wastage_mode: "PERCENT", wastage_value: "0" }],
      bank_amount: "50000", bank_details: bankR.label, discount: "1000",
      tcs_enabled: true, tcs_amount: "300",
    })
  ).group.id;

  // P2 2026-01-20 CASH: 50 g @ 91.6 = 45.8 pure × 6100 = 279380.
  //   bank 30000 (R), TCS 200. 279380 − 30000 + 200 = 249580 → no round-off.
  jan.P2 = (
    await purchase({
      account_id: sup1, date: "2026-01-20", rate_per_gram: "6100", balance_mode: "CASH",
      gold_items: [{ item_id: gold, quantity: "50", purity: "91.6" }],
      bank_amount: "30000", bank_details: bankR.label,
      tcs_enabled: true, tcs_amount: "200",
    })
  ).group.id;

  // S2 2026-01-25 CASH: 10 g @ 91.6 = 9.16 pure × 6305 = 57753.80.
  //   bank 20000 (R), TDS 150. 57753.80 − 20000 − 150 = 37603.80 → round-off +0.20
  //   (SHOP → customer, raises the bill).
  jan.S2 = (
    await sale({
      account_id: cus1, date: "2026-01-25", rate_per_gram: "6305", balance_mode: "CASH",
      items: [{ item_id: gold, quantity: "10", purity: "91.6", wastage_mode: "PERCENT", wastage_value: "0" }],
      bank_amount: "20000", bank_details: bankR.label,
      tds_enabled: true, tds_amount: "150",
    })
  ).group.id;

  // Manual Bank R moves: one inside January, one after it (must not show in a January report).
  await addBankFunds({ bankKey: bankR.key, direction: "CREDIT", amount: "5000", date: "2026-01-15", remarks: "in range" });
  await addBankFunds({ bankKey: bankR.key, direction: "CREDIT", amount: "999", date: "2026-02-10", remarks: "after range" });
});

// ─── BANK ─────────────────────────────────────────────────────────────────────

describe("Bank balances", () => {
  it("1. deposit, withdrawal and transfer between two banks give each bank the right balance", async () => {
    await addBankFunds({ bankKey: bankA.key, direction: "CREDIT", amount: "2500", date: "2026-05-02" }, USER);
    await addBankFunds({ bankKey: bankA.key, direction: "DEBIT", amount: "700", date: "2026-05-03" }, USER);
    const t = await transferBankFunds({ fromBankKey: bankA.key, toBankKey: bankB.key, amount: "1200", date: "2026-05-04" }, USER);
    expect(t.rows.length).toBe(2);
    expect(t.rows.every((r) => r.transfer_group_id === t.transferGroupId)).toBe(true);

    // A: 10000 + 2500 − 700 − 1200 = 10600
    const a = await ledger({ bankKey: bankA.key });
    expect(a.banks.length).toBe(1);
    expect(a.banks[0]!.opening).toBe(10000);
    expect(a.banks[0]!.totalCredit).toBe(2500);
    expect(a.banks[0]!.totalDebit).toBe(1900);
    expect(a.banks[0]!.closing).toBe(10600);
    // Log is newest first; the running balance follows the dates.
    expect(a.log.rows.map((r) => [r.type, r.direction, r.amount, r.balance])).toEqual([
      ["TRANSFER_OUT", "DEBIT", 1200, 10600],
      ["WITHDRAWAL", "DEBIT", 700, 11800],
      ["DEPOSIT", "CREDIT", 2500, 12500],
    ]);
    expect(a.log.rows[0]!.party).toBe(bankB.label);
    expect(a.log.rows[0]!.createdBy).toBe(USER.username);

    // B: 5000 + 1200 = 6200
    const b = await ledger({ bankKey: bankB.key });
    expect(b.banks[0]!.opening).toBe(5000);
    expect(b.banks[0]!.totalCredit).toBe(1200);
    expect(b.banks[0]!.totalDebit).toBe(0);
    expect(b.banks[0]!.closing).toBe(6200);
    expect(b.log.rows.map((r) => [r.type, r.direction, r.amount, r.party])).toEqual([
      ["TRANSFER_IN", "CREDIT", 1200, bankA.label],
    ]);

    // A transfer moves money, it does not create any: A + B together only gained the 1800 net deposit.
    const both = await ledger({});
    const sum = (k: string) => both.banks.find((x) => x.key === k)!.closing;
    expect(sum(bankA.key) + sum(bankB.key)).toBe(10000 + 5000 + 2500 - 700);
  });

  it("1b. money into a bank that is not configured is refused", async () => {
    let msg: string | null = null;
    try {
      await addBankFunds({ bankKey: "no such bank|000", direction: "CREDIT", amount: "10", date: "2026-05-05" });
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toBe("That bank is no longer configured in Company Details.");
  });

  describe("2. sale / purchase / expense payments through a bank", () => {
    let cus2: string;
    let sup2: string;
    let saleId: string;
    let purchaseId: string;
    let expenseId: string;

    it("2a. each payment shows in that bank's ledger and moves its balance", async () => {
      cus2 = await newAccount("Bank Customer", "CUSTOMER", "CUSTOMER");
      sup2 = await newAccount("Bank Supplier", "CUSTOMER", "PURCHASER");

      // Sale 5 g @ 91.6 × 6000 = 27480 (CASH mode), customer pays 8000 into Bank C.
      saleId = (
        await sale({
          account_id: cus2, date: "2026-03-05", rate_per_gram: "6000", balance_mode: "CASH",
          items: [{ item_id: gold, quantity: "5", purity: "91.6", wastage_mode: "PERCENT", wastage_value: "0" }],
          bank_amount: "8000", bank_details: bankC.label,
        })
      ).group.id;
      // Purchase 10 g @ 91.6 (PURE), shop pays the supplier 3000 from Bank C.
      purchaseId = (
        await purchase({
          account_id: sup2, date: "2026-03-06", rate_per_gram: "6000",
          gold_items: [{ item_id: gold, quantity: "10", purity: "91.6" }],
          bank_amount: "3000", bank_details: bankC.label,
        })
      ).group.id;
      // Expense 700 paid from Bank C.
      expenseId = (
        await createExpense({
          date: "2026-03-07", name: `${RUN} Rent`, amount: "700", reason: "rent",
          from_account_id: SYSTEM_ACCOUNTS.BANK_ID, bank_details: bankC.label,
        })
      ).group.id;

      // C: 0 + 8000 − 3000 − 700 = 4300
      const c = await ledger({ bankKey: bankC.key });
      expect(c.banks[0]!.opening).toBe(0);
      expect(c.banks[0]!.totalCredit).toBe(8000);
      expect(c.banks[0]!.totalDebit).toBe(3700);
      expect(c.banks[0]!.closing).toBe(4300);
      expect(c.log.rows.map((r) => [r.groupId, r.type, r.direction, r.amount, r.balance])).toEqual([
        [expenseId, "EXPENSE", "DEBIT", 700, 4300],
        [purchaseId, "PURCHASE", "DEBIT", 3000, 5000],
        [saleId, "SALE", "CREDIT", 8000, 8000],
      ]);
      // No payment landed in the "Unassigned" bucket.
      const all = await ledger({});
      expect(all.banks.some((b) => b.key === "__unassigned__")).toBe(false);
    });

    it("2b. a later Pay-popup payment through the bank also shows in its ledger", async () => {
      // 27480 − 8000 = 19480 still due; pay 480 more into Bank C.
      const r = await settleSalePayment({ id: saleId, amount: "480", method: "BANK", bank_details: bankC.label });
      expect(r.balance).toBe(19000);
      const c = await ledger({ bankKey: bankC.key });
      expect(c.banks[0]!.totalCredit).toBe(8480);
      expect(c.banks[0]!.closing).toBe(4780);
      expect(c.log.rows.filter((x) => x.groupId === saleId).map((x) => x.amount).sort()).toEqual([480, 8000]);
    });

    // Was a bug: loadBillTransactions skipped the deleted bill but still read its
    // REVERSAL group (same bank label, from/to swapped), so the 8480 receipt came
    // back as an 8480 DEBIT (closing −12180 instead of −3700).
    it("2c. deleting the sale and the purchase takes their payments out of the bank", async () => {
      await deleteSale({ id: saleId }, USER);
      // Only the purchase (−3000) and the expense (−700) are left: 0 − 3700 = −3700.
      let c = await ledger({ bankKey: bankC.key });
      expect(c.banks[0]!.totalCredit).toBe(0);
      expect(c.banks[0]!.closing).toBe(-3700);

      await deletePurchase({ id: purchaseId });
      // Only the expense is left: −700.
      c = await ledger({ bankKey: bankC.key });
      expect(c.banks[0]!.totalDebit).toBe(700);
      expect(c.banks[0]!.closing).toBe(-700);
      expect(c.log.rows.map((r) => [r.groupId, r.amount])).toEqual([[expenseId, 700]]);
    });

    // Editing a bill also reverses the original (soft-deleted + REVERSAL group) and
    // posts the new version, so this is the everyday form of the 2c bug.
    it("2d. editing a sale that was paid into the bank shows only the new payment, once", async () => {
      const cus3 = await newAccount("Bank Edit Customer", "CUSTOMER", "CUSTOMER");
      const bill = {
        account_id: cus3, date: "2026-06-10", rate_per_gram: "6000", balance_mode: "CASH",
        items: [{ item_id: gold, quantity: "5", purity: "91.6", wastage_mode: "PERCENT", wastage_value: "0" }],
        bank_details: bankC.label,
      };
      const firstId = (await sale({ ...bill, bank_amount: "8000" })).group.id;
      const JUNE = { bankKey: bankC.key, from_date: "2026-06-01", to_date: "2026-06-30" };

      // Opening on 1 June = 0 configured − 700 (the expense left after 2c) = −700.
      let c = await ledger(JUNE);
      expect(c.banks[0]!.opening).toBe(-700);
      expect(c.banks[0]!.totalCredit).toBe(8000);
      expect(c.banks[0]!.closing).toBe(7300); // −700 + 8000

      // Same bill, customer now paid 6000 into Bank C.
      const editedId = (await editSale({ ...bill, id: firstId, bank_amount: "6000" })).group.id;
      c = await ledger(JUNE);
      // Only the new 6000 receipt: no 8000 left behind, no 8000 coming back as a withdrawal.
      expect(c.log.rows.map((r) => [r.groupId, r.type, r.direction, r.amount, r.balance])).toEqual([
        [editedId, "SALE", "CREDIT", 6000, 5300],
      ]);
      expect(c.banks[0]!.opening).toBe(-700);
      expect(c.banks[0]!.totalCredit).toBe(6000);
      expect(c.banks[0]!.totalDebit).toBe(0);
      expect(c.banks[0]!.closing).toBe(5300); // −700 + 6000

      // Whole-history view agrees: −700 + 6000 = 5300.
      const all = await ledger({ bankKey: bankC.key });
      expect(all.banks[0]!.opening).toBe(0);
      expect(all.banks[0]!.closing).toBe(5300);
      expect(all.log.rows.filter((r) => r.type === "REVERSAL")).toHaveLength(0);
    });
  });
});

// ─── REPORTS (January) ────────────────────────────────────────────────────────

const JAN = { from_date: "2026-01-01", to_date: "2026-01-31" };

describe("Reports match the January bills", () => {
  it("3a. reports.transactions SALE: per-bill and day/month totals equal the bills", async () => {
    const day = await getTransactionReport({ type: "SALE", ...JAN, group_by: "day" });
    expect(day.bills.map((b) => b.id)).toEqual([jan.S1, jan.S2]);

    const [s1, s2] = day.bills;
    // S1: 20 g out, 18.32 pure, 113584 goods, 50000 received, 1000 discount
    expect(s1!.weightOut).toBe(20);
    expect(s1!.pureOut).toBe(18.32);
    expect(s1!.amount).toBe(113584);
    expect(s1!.cashIn).toBe(50000);
    expect(s1!.cashOut).toBe(0);
    expect(s1!.discount).toBe(1000);
    expect(s1!.party).toContain("Jan Customer");
    // S2: 10 g out, 9.16 pure, 9.16 × 6305 = 57753.80, 20000 received
    expect(s2!.weightOut).toBe(10);
    expect(s2!.pureOut).toBe(9.16);
    expect(s2!.amount).toBeCloseTo(57753.8, 2);
    expect(s2!.cashIn).toBe(20000);
    expect(s2!.discount).toBe(0);

    expect(day.summary.map((p) => [p.period, p.bills, p.weightOut])).toEqual([
      ["2026-01-10", 1, 20],
      ["2026-01-25", 1, 10],
    ]);

    const month = await getTransactionReport({ type: "SALE", ...JAN, group_by: "month" });
    expect(month.summary.length).toBe(1);
    const m = month.summary[0]!;
    expect(m.period).toBe("2026-01");
    expect(m.bills).toBe(2);
    expect(m.weightOut).toBe(30);
    expect(m.pureOut).toBe(27.48);
    expect(m.amount).toBeCloseTo(113584 + 57753.8, 2); // 171337.80
    expect(m.discount).toBe(1000);
    expect(m.cashIn).toBe(70000);
    expect(month.totals.bills).toBe(2);
    expect(month.totals.amount).toBeCloseTo(171337.8, 2);
    expect(month.totals.cashIn).toBe(70000);
  });

  it("3b. reports.transactions PURCHASE: per-bill and month totals equal the bills", async () => {
    const r = await getTransactionReport({ type: "PURCHASE", ...JAN, group_by: "month" });
    expect(r.bills.map((b) => b.id)).toEqual([jan.P1, jan.P2]);
    const [p1, p2] = r.bills;
    // P1: 100 g in, 91.6 pure × 6000 = 549600; paid 10000; discount 500
    expect(p1!.weightIn).toBe(100);
    expect(p1!.pureIn).toBe(91.6);
    expect(p1!.amount).toBe(549600);
    expect(p1!.cashOut).toBe(10000);
    expect(p1!.discount).toBe(500);
    // P2: 50 g in, 45.8 pure × 6100 = 279380; paid 30000
    expect(p2!.weightIn).toBe(50);
    expect(p2!.pureIn).toBe(45.8);
    expect(p2!.amount).toBe(279380);
    expect(p2!.cashOut).toBe(30000);

    expect(r.summary).toHaveLength(1);
    expect(r.totals.bills).toBe(2);
    expect(r.totals.weightIn).toBe(150);
    expect(r.totals.pureIn).toBe(137.4);
    expect(r.totals.amount).toBe(828980);
    expect(r.totals.cashOut).toBe(40000);
    expect(r.totals.cashIn).toBe(0);
    expect(r.totals.discount).toBe(500);

    // A party filter keeps only that party's bills.
    const none = await getTransactionReport({ type: "PURCHASE", ...JAN, group_by: "day", account_id: cus1 });
    expect(none.bills).toHaveLength(0);
  });

  // Was a bug: getTransactionReport took TDS/TCS only from entry_groups.tds_amount /
  // tcs_amount, which createSale / createPurchase never set (they post "TDS
  // Adjustment" / "TCS Adjustment" money lines instead), so it showed 0.
  it("3c. reports.transactions shows each bill's TDS / TCS", async () => {
    const s = await getTransactionReport({ type: "SALE", ...JAN, group_by: "month" });
    // S1 TCS 300, S2 TDS 150
    expect(s.bills.map((b) => [b.tds, b.tcs])).toEqual([[0, 300], [150, 0]]);
    expect([s.totals.tds, s.totals.tcs]).toEqual([150, 300]);

    const p = await getTransactionReport({ type: "PURCHASE", ...JAN, group_by: "month" });
    // P1 TDS 100, P2 TCS 200
    expect(p.bills.map((b) => [b.tds, b.tcs])).toEqual([[100, 0], [0, 200]]);
  });

  it("4. reports.detailed: goods amount, payments, discount, TDS/TCS and round-off per bill", async () => {
    const s = await getDetailedReport({ type: "SALE", ...JAN });
    expect(s.bills.map((b) => b.id)).toEqual([jan.S1, jan.S2]);
    const [s1, s2] = s.bills;
    expect(s1).toMatchObject({
      account_id: cus1, rate_per_gram: 6200, goods_amount: 113584,
      cash_received: 50000, cash_paid: 0, discount: 1000, tds: 0, tcs: 300, round_off: 0, gst: 0,
    });
    expect(s1!.lines).toEqual([
      expect.objectContaining({ item_id: gold, section: "GOLD_ISSUE", weight: 20, touch: 91.6, pure: 18.32, rate: 6200, amount: 113584 }),
    ]);
    expect(s2).toMatchObject({
      rate_per_gram: 6305, cash_received: 20000, cash_paid: 0, discount: 0, tds: 150, tcs: 0,
    });
    expect(s2!.goods_amount).toBeCloseTo(57753.8, 2);
    expect(s2!.round_off).toBeCloseTo(0.2, 2); // raises the bill
    expect(s2!.lines).toHaveLength(1);
    expect(s2!.lines[0]!.pure).toBe(9.16);

    const p = await getDetailedReport({ type: "PURCHASE", ...JAN });
    expect(p.bills.map((b) => b.id)).toEqual([jan.P1, jan.P2]);
    const [p1, p2] = p.bills;
    expect(p1).toMatchObject({
      account_id: sup1, goods_amount: 549600, cash_paid: 10000, cash_received: 0,
      discount: 500, tds: 100, tcs: 0, round_off: 0,
    });
    expect(p1!.lines).toEqual([
      expect.objectContaining({ section: "GOLD_RECEIPT", weight: 100, pure: 91.6, rate: 6000, amount: 549600 }),
    ]);
    expect(p2).toMatchObject({ goods_amount: 279380, cash_paid: 30000, discount: 0, tds: 0, tcs: 200, round_off: 0 });
    expect(p2!.lines[0]).toMatchObject({ section: "GOLD_RECEIPT", weight: 50, pure: 45.8, rate: 6100 });
  });

  it("5a. reports.bank for Bank R in January: opening / debit / credit / closing", async () => {
    const r = await getBankReport({ ...JAN, group_by: "day", bank_key: bankR.key });
    // In range: P1 −10000 (01-05), S1 +50000 (01-10), deposit +5000 (01-15),
    //           P2 −30000 (01-20), S2 +20000 (01-25). The 02-10 deposit is outside.
    expect(r.transactions.map((t) => [t.date, t.direction, t.amount])).toEqual([
      ["2026-01-05", "DEBIT", 10000],
      ["2026-01-10", "CREDIT", 50000],
      ["2026-01-15", "CREDIT", 5000],
      ["2026-01-20", "DEBIT", 30000],
      ["2026-01-25", "CREDIT", 20000],
    ]);
    expect(r.transactions.map((t) => t.groupId)).toEqual([jan.P1, jan.S1, null, jan.P2, jan.S2]);
    // Running balance from the 1000 opening.
    expect(r.transactions.map((t) => t.balance)).toEqual([-9000, 41000, 46000, 16000, 36000]);

    expect(r.banks).toHaveLength(1);
    expect(r.totals).toEqual({ opening: 1000, debit: 40000, credit: 75000, closing: 36000 });
    expect(r.summary.map((p) => [p.period, p.count, p.credit, p.debit, p.net])).toEqual([
      ["2026-01-05", 1, 0, 10000, -10000],
      ["2026-01-10", 1, 50000, 0, 50000],
      ["2026-01-15", 1, 5000, 0, 5000],
      ["2026-01-20", 1, 0, 30000, -30000],
      ["2026-01-25", 1, 20000, 0, 20000],
    ]);

    const month = await getBankReport({ ...JAN, group_by: "month", bank_key: bankR.key });
    expect(month.summary).toEqual([{ period: "2026-01", count: 5, credit: 75000, debit: 40000, net: 35000 }]);
  });

  // Was a bug: getBankLedger used the configured opening balance while dropping every
  // transaction before from_date, so the opening left out everything before the From date.
  it("5b. reports.bank opening for a date range includes money moved before the From date", async () => {
    // A deposit before the range: the opening on 2026-01-01 is 1000 + 2000 = 3000,
    // so the January closing is 3000 + 75000 − 40000 = 38000.
    await addBankFunds({ bankKey: bankR.key, direction: "CREDIT", amount: "2000", date: "2025-12-20" });
    const r = await getBankReport({ ...JAN, group_by: "month", bank_key: bankR.key });
    expect(r.totals.credit).toBe(75000);
    expect(r.totals.debit).toBe(40000);
    expect(r.totals.opening).toBe(3000);
    expect(r.totals.closing).toBe(38000);
  });

  it("6. reports.stock: opening, in/out weight and pure, closing", async () => {
    const r = await getStockReport({ ...JAN, group_by: "month" });
    const row = r.items.find((i) => i.itemName.endsWith("Gold 91.6") && i.touch === "91.600");
    // Opening 500 g (458 pure); in P1 100 + P2 50 = 150 g (91.6 + 45.8 = 137.4 pure);
    // out S1 20 + S2 10 = 30 g (18.32 + 9.16 = 27.48 pure). Closing 620 g / 567.92 pure.
    expect(row).toEqual({
      itemName: expect.stringContaining("Gold 91.6"),
      itemType: "GOLD",
      touch: "91.600",
      openingWeight: 500,
      inWeight: 150,
      outWeight: 30,
      closingWeight: 620,
      openingPure: 458,
      inPure: 137.4,
      outPure: 27.48,
      closingPure: 567.92,
    });
    // Nothing else moved in January.
    expect(r.summary).toEqual([{ period: "2026-01", inWeight: 150, outWeight: 30, inPure: 137.4, outPure: 27.48 }]);

    const day = await getStockReport({ ...JAN, group_by: "day" });
    expect(day.summary.map((p) => [p.period, p.inWeight, p.outWeight])).toEqual([
      ["2026-01-05", 100, 0],
      ["2026-01-10", 0, 20],
      ["2026-01-20", 50, 0],
      ["2026-01-25", 0, 10],
    ]);
  });

  // Was a bug: a CASH-mode sale stores pure_quantity "0" on its goods line, so the
  // reports fell back to weight × touch and dropped the wastage (54960 instead of 57960).
  it("6b. a cash-mode sale with wastage reports the billed goods value (wastage included)", async () => {
    const cw = await newAccount("Wastage Customer", "CUSTOMER", "CUSTOMER");
    // 10 g @ 91.6 with 5 % wastage: wastage = 10 × 5 / 91.6 g, pure = 9.16 + 0.5 = 9.66
    // × 6000 = 57960 billed (Cash Sale Charge).
    const s = await sale({
      account_id: cw, date: "2026-04-05", rate_per_gram: "6000", balance_mode: "CASH",
      items: [{ item_id: gold, quantity: "10", purity: "91.6", wastage_mode: "PERCENT", wastage_value: "5" }],
    });
    const charge = s.entries.find((e: { remarks: string | null }) => e.remarks === "Cash Sale Charge");
    expect(Number(charge!.quantity)).toBe(57960);

    const range = { from_date: "2026-04-01", to_date: "2026-04-30", account_id: cw };
    const t = await getTransactionReport({ type: "SALE", ...range, group_by: "day" });
    const d = await getDetailedReport({ type: "SALE", ...range });
    expect(t.bills[0]!.amount).toBe(57960);
    expect(t.bills[0]!.weightOut).toBe(10); // physical weight only
    expect(t.bills[0]!.pureOut).toBe(9.66); // same as the PURE-mode bill (6c)
    expect(d.bills[0]!.goods_amount).toBe(57960);
    expect(d.bills[0]!.lines[0]).toMatchObject({ weight: 10, pure: 9.66, amount: 57960 });
  });

  it("6c. the same wastage sale in PURE mode reports the billed goods value", async () => {
    const cp = await newAccount("Wastage Customer Pure", "CUSTOMER", "CUSTOMER");
    await sale({
      account_id: cp, date: "2026-04-06", rate_per_gram: "6000",
      items: [{ item_id: gold, quantity: "10", purity: "91.6", wastage_mode: "PERCENT", wastage_value: "5" }],
    });
    const range = { from_date: "2026-04-01", to_date: "2026-04-30", account_id: cp };
    const t = await getTransactionReport({ type: "SALE", ...range, group_by: "day" });
    expect(t.bills[0]!.weightOut).toBe(10); // physical weight only
    expect(t.bills[0]!.pureOut).toBe(9.66);
    expect(t.bills[0]!.amount).toBe(57960);
  });
});

// ─── CUSTOMER BALANCE REPORT (February) ───────────────────────────────────────

// To date reaches past "now" so every entry's created_at is inside the "as on" cut-off.
const CB = { from_date: "2026-02-01", to_date: "2026-12-31" };

describe("7. Customer Balance report", () => {
  let cb1: string;
  let cb2: string;
  const b = {} as Record<"B1" | "B2" | "B3", string>;

  it("7a. sales customer: each bill's opening = previous closing, closing = opening + bill", async () => {
    cb1 = await newAccount("CB Customer", "CUSTOMER", "CUSTOMER");

    // B1 PURE 10 g @ 91.6 = 9.16 pure owed.
    b.B1 = (
      await sale({
        account_id: cb1, date: "2026-02-03", rate_per_gram: "6000",
        items: [{ item_id: gold, quantity: "10", purity: "91.6", wastage_mode: "PERCENT", wastage_value: "0" }],
      })
    ).group.id;
    // Payment between the bills: 5000 cash against B1 (Pay popup) → B1 cash −5000.
    await settleSalePayment({ id: b.B1, amount: "5000", method: "CASH" });
    // B2 CASH 5 g @ 91.6 × 6000 = 27480 owed in cash.
    b.B2 = (
      await sale({
        account_id: cb1, date: "2026-02-10", rate_per_gram: "6000", balance_mode: "CASH",
        items: [{ item_id: gold, quantity: "5", purity: "91.6", wastage_mode: "PERCENT", wastage_value: "0" }],
      })
    ).group.id;
    // B3 PURE 2 g @ 91.6 = 1.832 pure, paid 1000 cash on the bill.
    b.B3 = (
      await sale({
        account_id: cb1, date: "2026-02-20", rate_per_gram: "6000",
        items: [{ item_id: gold, quantity: "2", purity: "91.6", wastage_mode: "PERCENT", wastage_value: "0" }],
        bank_amount: "1000", bank_details: "Cash",
      })
    ).group.id;

    const r = await getCustomerBalanceReport({ type: "SALE", ...CB, account_id: cb1 });
    expect(r.bills.map((x) => x.id)).toEqual([b.B1, b.B2, b.B3]);
    const pick = (x: (typeof r.bills)[number]) => [
      x.opening_pure, x.opening_cash, x.bill_pure, x.bill_cash, x.closing_pure, x.closing_cash,
    ];
    expect(r.bills.map(pick)).toEqual([
      [0, 0, 9.16, -5000, 9.16, -5000],
      [9.16, -5000, 0, 27480, 9.16, 22480],
      [9.16, 22480, 1.832, -1000, 10.992, 21480],
    ]);
    // Chain rule, stated generally.
    for (let i = 0; i < r.bills.length; i++) {
      const x = r.bills[i]!;
      expect(x.closing_pure).toBeCloseTo(x.opening_pure + x.bill_pure, 3);
      expect(x.closing_cash).toBeCloseTo(x.opening_cash + x.bill_cash, 2);
      if (i > 0) {
        expect(x.opening_pure).toBe(r.bills[i - 1]!.closing_pure);
        expect(x.opening_cash).toBe(r.bills[i - 1]!.closing_cash);
      }
    }
    expect(r.parties).toEqual([
      { account_id: cb1, party_name: expect.stringContaining("CB Customer"), bills: 3, balance_pure: 10.992, balance_cash: 21480 },
    ]);
  });

  it("7b. a payment after the last bill shows in the party balance as on the To date", async () => {
    // 2000 more cash paid through the Pay popup on B3, after B3 was made.
    await settleSalePayment({ id: b.B3, amount: "2000", method: "CASH" });
    const r = await getCustomerBalanceReport({ type: "SALE", ...CB, account_id: cb1 });
    expect(r.parties[0]!.balance_cash).toBe(19480); // 21480 − 2000
    expect(r.parties[0]!.balance_pure).toBe(10.992);
  });

  it("7c. goldsmith: a standalone Cash Received after the last labour bill is in the party balance, not in the bill", async () => {
    const gs = await newAccount("CB Goldsmith", "GOLDSMITH", "GOLD_SMITH");
    const cycle = await createCycle({ account_id: gs, main_reason: "report test" });
    const lb = (date: string, qty: string, extra: Record<string, unknown> = {}) =>
      createLabourBill({
        account_id: gs, date, rate_per_gram: "6000", bill_cycle_id: cycle.id,
        gold_issue: [{ item_id: lbGold, quantity: qty, purity: "92" }],
        gold_receipt: [], ornament_issue: [], ornament_receipt: [], cash_conversions: [],
        ...extra,
      });
    const l1 = (await lb("2026-02-05", "10")).group.id; // +9.2 pure
    const l2 = (await lb("2026-02-15", "5", { bank_paid: "1000", bank_paid_details: "Cash" })).group.id; // +4.6 pure, +1000 cash
    await receiveCash({ account_id: gs, amount: "400", date: "2026-02-25", details: "Cash" }); // −400 cash, no bill no

    const r = await getCustomerBalanceReport({ type: "LABOUR_BILL", ...CB, account_id: gs });
    // The standalone receipt carries no bill number, so it is not a row.
    expect(r.bills.map((x) => x.id)).toEqual([l1, l2]);
    expect(r.bills.map((x) => [x.opening_pure, x.opening_cash, x.closing_pure, x.closing_cash])).toEqual([
      [0, 0, 9.2, 0],
      [9.2, 0, 13.8, 1000],
    ]);
    // Party balance as on the To date: 13.8 pure, 1000 − 400 = 600 cash.
    expect(r.parties).toEqual([
      { account_id: gs, party_name: expect.stringContaining("CB Goldsmith"), bills: 2, balance_pure: 13.8, balance_cash: 600 },
    ]);
  });

  it("7d. supplier: signs are flipped (+ = shop owes the supplier)", async () => {
    const sb = await newAccount("CB Supplier", "CUSTOMER", "PURCHASER");
    // Q1 PURE 10 g @ 91.6 → shop owes 9.16 pure.
    const q1 = (
      await purchase({
        account_id: sb, date: "2026-02-04", rate_per_gram: "6000",
        gold_items: [{ item_id: gold, quantity: "10", purity: "91.6" }],
      })
    ).group.id;
    // Q2 CASH 5 g @ 91.6 × 6000 = 27480 owed, 7000 paid → bill +20480.
    const q2 = (
      await purchase({
        account_id: sb, date: "2026-02-12", rate_per_gram: "6000", balance_mode: "CASH",
        gold_items: [{ item_id: gold, quantity: "5", purity: "91.6" }],
        bank_amount: "7000", bank_details: "Cash",
      })
    ).group.id;

    const r = await getCustomerBalanceReport({ type: "PURCHASE", ...CB, account_id: sb });
    expect(r.bills.map((x) => x.id)).toEqual([q1, q2]);
    // "+ 0" turns the flipped −0 into 0 (they print and serialise the same).
    expect(
      r.bills.map((x) =>
        [x.opening_pure, x.opening_cash, x.bill_pure, x.bill_cash, x.closing_pure, x.closing_cash].map((v) => v + 0),
      ),
    ).toEqual([
      [0, 0, 9.16, 0, 9.16, 0],
      [9.16, 0, 0, 20480, 9.16, 20480],
    ]);
    expect(r.parties[0]).toMatchObject({ account_id: sb, bills: 2, balance_pure: 9.16, balance_cash: 20480 });
  });

  it("7e. the party filter (account_id) returns only that party", async () => {
    cb2 = await newAccount("CB Customer Two", "CUSTOMER", "CUSTOMER");
    await sale({
      account_id: cb2, date: "2026-02-11", rate_per_gram: "6000",
      items: [{ item_id: gold, quantity: "1", purity: "91.6", wastage_mode: "PERCENT", wastage_value: "0" }],
    });

    const all = await getCustomerBalanceReport({ type: "SALE", ...CB });
    const ids = new Set(all.parties.map((p) => p.account_id));
    expect(ids.has(cb1)).toBe(true);
    expect(ids.has(cb2)).toBe(true);

    const only = await getCustomerBalanceReport({ type: "SALE", ...CB, account_id: cb2 });
    expect(only.bills.length).toBe(1);
    expect(only.bills.every((x) => x.account_id === cb2)).toBe(true);
    expect(only.parties.map((p) => p.account_id)).toEqual([cb2]);
    expect(only.parties[0]).toMatchObject({ bills: 1, balance_pure: 0.916, balance_cash: 0 });
  });

  // Was a bug: the party balance was cut off by entry created_at ≤ To date, not by
  // the bill's date, so a bill keyed in after the To date was listed but left out.
  it("7f. a bill dated inside the range counts in the balance as on the To date, even if keyed in later", async () => {
    const cb3 = await newAccount("CB Late Entry", "CUSTOMER", "CUSTOMER");
    // Bill dated 2026-02-08 but typed in today (created_at = now, after 2026-02-28).
    await sale({
      account_id: cb3, date: "2026-02-08", rate_per_gram: "6000",
      items: [{ item_id: gold, quantity: "10", purity: "91.6", wastage_mode: "PERCENT", wastage_value: "0" }],
    });
    const r = await getCustomerBalanceReport({ type: "SALE", from_date: "2026-02-01", to_date: "2026-02-28", account_id: cb3 });
    expect(r.bills).toHaveLength(1);
    expect(r.bills[0]!.closing_pure).toBe(9.16);
    // The only bill closes at 9.16 and nothing else happened → balance as on 28-Feb is 9.16.
    expect(r.parties[0]!.balance_pure).toBe(9.16);
  });

  // 10 g @ 91.6 = 9.16 pure on 14 Feb, then edited to 5 g = 4.58 pure dated 16 Feb.
  let cb4: string;
  let editedId: string;
  const FEB = { type: "SALE" as const, from_date: "2026-02-01", to_date: "2026-02-28" };

  it("7g. an edited bill counts once in the party balance (the original and its cancel entry net to zero)", async () => {
    cb4 = await newAccount("CB Edited", "CUSTOMER", "CUSTOMER");
    const firstId = (
      await sale({
        account_id: cb4, date: "2026-02-14", rate_per_gram: "6000",
        items: [{ item_id: gold, quantity: "10", purity: "91.6", wastage_mode: "PERCENT", wastage_value: "0" }],
      })
    ).group.id;
    editedId = (
      await editSale({
        id: firstId, account_id: cb4, date: "2026-02-16", rate_per_gram: "6000",
        items: [{ item_id: gold, quantity: "5", purity: "91.6", wastage_mode: "PERCENT", wastage_value: "0" }],
      })
    ).group.id;

    const r = await getCustomerBalanceReport({ ...FEB, account_id: cb4 });
    expect(r.bills.map((x) => [x.id, x.bill_pure])).toEqual([[editedId, 4.58]]);
    expect(r.parties[0]).toMatchObject({ bills: 1, balance_pure: 4.58, balance_cash: 0 });
  });

  // BUG: lib/balance.ts getBatchAggregateBalances (used by the Sales/Purchase/Labour/
  // Job Works history tables and by these bill rows) compares entries.created_at with
  // a JS Date, which drops the microseconds. An edit now reverses + re-posts in ONE
  // transaction, so the REVERSAL and the new bill share the same created_at (e.g.
  // …47.336350) while the cut-off becomes …47.336000: the REVERSAL is left out, the
  // original 9.16 is not, and the edited bill opens at 9.16 instead of 0.
  it("7h. an edited bill's opening leaves out the bill it replaced", async () => {
    const r = await getCustomerBalanceReport({ ...FEB, account_id: cb4 });
    expect(r.bills.map((x) => [x.id, x.opening_pure, x.bill_pure, x.closing_pure])).toEqual([[editedId, 0, 4.58, 4.58]]);
  });
});

describe("8. Conversions never show as bank money", () => {
  it("8a. a Gold→Cash conversion (Convert button) stays out of the bank ledger", async () => {
    // Customer owes 9.160 g (10 g @ 91.6, credit) → convert 2 g @ 6000 to cash.
    const cus = await newAccount("Conv Customer", "CUSTOMER", "CUSTOMER");
    await sale({
      account_id: cus, date: "2026-04-01", rate_per_gram: "6000",
      items: [{ item_id: gold, quantity: "10", purity: "91.6", wastage_mode: "PERCENT", wastage_value: "0" }],
    });
    const conv = await convertGoldToCash(
      ConvertGoldToCashSchema.parse({ account_id: cus, gold_grams: "2", rate_per_gram: "6000" }),
    );
    const convGroupId = conv.group.id;

    // Walk every page of the all-banks ledger.
    const rows: BankTransaction[] = [];
    for (let page = 1; ; page++) {
      const r = await ledger({ page });
      rows.push(...r.log.rows);
      if (page >= r.log.totalPages) break;
    }
    expect(rows.filter((t) => t.groupId === convGroupId || /conversion/i.test(t.bankLabel))).toEqual([]);
  });
});

afterAll(async () => {
  await (db as unknown as { $client?: { end?: (o?: { timeout?: number }) => Promise<void> } }).$client?.end?.({ timeout: 5 });
});
