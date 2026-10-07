import { and, asc, eq, gte, inArray, isNotNull, lte, ne } from "drizzle-orm";
import { db } from "@/db";
import { accounts, entries, entryGroups, items } from "@/db/schema";
import { SYSTEM_ACCOUNTS } from "@/config/constants";
import { getBankLedger } from "@/modules/bank/service";
import { isConversion, lineGoodsAmount, linePure } from "./goodsValue";
import type {
  BankReportInput,
  StockReportInput,
  DetailedReportInput,
  TransactionReportInput,
} from "./schema";

// ─── Shared helpers ───────────────────────────────────────────────────────────

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const num = (v: string | null | undefined) => Number.parseFloat(v || "0") || 0;

/** "2026-09-17" → "2026-09-17" (day) or "2026-09" (month). */
function periodOf(date: string, groupBy: "day" | "month"): string {
  return groupBy === "month" ? date.slice(0, 7) : date;
}

/**
 * Money entries on a bill that are NOT a payment. They ride the same RUPEE item as
 * a real bank/cash payment, so they have to be recognised by their remark — the
 * same list the history tables and the bank ledger use.
 */
const NON_PAYMENT_REMARKS = new Set([
  "Discount",
  "Cash Purchase Charge",
  "Cash Sale Charge",
  "Hallmark",
  "Hallmark GST",
  "TDS Adjustment",
  "TCS Adjustment",
  "GST",
  "Round Off",
]);


/**
 * In-bill gold→cash conversion on a labour bill / job work:
 * "Cash conversion: {grams}g @ ₹{rate}/g". It moves the goldsmith's debt from
 * gold to cash — no money changes hands, so it is never a payment.
 */
const CASH_CONVERSION_PREFIX = "Cash conversion:";

function isNonPaymentRemark(remark: string): boolean {
  return NON_PAYMENT_REMARKS.has(remark) || remark.startsWith(CASH_CONVERSION_PREFIX);
}

/** Grams converted, parsed back out of a "Cash conversion: 1.234g @ ₹…" remark. */
function conversionGrams(remark: string): number {
  const match = /^Cash conversion:\s*([\d.]+)\s*g/i.exec(remark);
  return match ? Number.parseFloat(match[1] ?? "0") || 0 : 0;
}

// ─── Bill-based reports (Sales / Purchase / Labour / Job Work / Expense) ─────

export interface ReportBill {
  id: string;
  date: string;
  billNo: number | null;
  entryNo: number | null;
  party: string;
  items: string;
  /** Goods into the shop. */
  weightIn: number;
  pureIn: number;
  /** Goods out of the shop. */
  weightOut: number;
  pureOut: number;
  /** Goods value: pure × rate (weight × rate for a touch-0 direct line). */
  amount: number;
  gst: number;
  discount: number;
  tds: number;
  tcs: number;
  /** Money received by the shop / paid out by the shop on this bill. */
  cashIn: number;
  cashOut: number;
  remarks: string | null;
}

export interface ReportPeriod {
  period: string;
  bills: number;
  weightIn: number;
  pureIn: number;
  weightOut: number;
  pureOut: number;
  amount: number;
  gst: number;
  discount: number;
  tds: number;
  tcs: number;
  cashIn: number;
  cashOut: number;
}

const emptyTotals = () => ({
  weightIn: 0,
  pureIn: 0,
  weightOut: 0,
  pureOut: 0,
  amount: 0,
  gst: 0,
  discount: 0,
  tds: 0,
  tcs: 0,
  cashIn: 0,
  cashOut: 0,
});

type Totals = ReturnType<typeof emptyTotals>;

function addInto(target: Totals, bill: ReportBill) {
  target.weightIn += bill.weightIn;
  target.pureIn += bill.pureIn;
  target.weightOut += bill.weightOut;
  target.pureOut += bill.pureOut;
  target.amount += bill.amount;
  target.gst += bill.gst;
  target.discount += bill.discount;
  target.tds += bill.tds;
  target.tcs += bill.tcs;
  target.cashIn += bill.cashIn;
  target.cashOut += bill.cashOut;
}

function roundTotals<T extends Totals>(t: T): T {
  return {
    ...t,
    weightIn: round3(t.weightIn),
    pureIn: round3(t.pureIn),
    weightOut: round3(t.weightOut),
    pureOut: round3(t.pureOut),
    amount: round2(t.amount),
    gst: round2(t.gst),
    discount: round2(t.discount),
    tds: round2(t.tds),
    tcs: round2(t.tcs),
    cashIn: round2(t.cashIn),
    cashOut: round2(t.cashOut),
  };
}

export async function getTransactionReport(input: TransactionReportInput) {
  const groupConditions = [
    eq(entryGroups.type, input.type),
    eq(entryGroups.is_deleted, false),
    // Real bills only: conversions and standalone "Cash Received (…)" settlements
    // carry no bill number.
    isNotNull(entryGroups.bill_no),
    gte(entryGroups.date, input.from_date),
    lte(entryGroups.date, input.to_date),
  ];
  if (input.account_id) groupConditions.push(eq(entryGroups.account_id, input.account_id));

  const groups = await db
    .select({
      id: entryGroups.id,
      date: entryGroups.date,
      billNo: entryGroups.bill_no,
      entryNo: entryGroups.entry_no,
      ratePerGram: entryGroups.rate_per_gram,
      remarks: entryGroups.remarks,
      tds: entryGroups.tds_amount,
      tcs: entryGroups.tcs_amount,
      party: accounts.name,
    })
    .from(entryGroups)
    .innerJoin(accounts, eq(entryGroups.account_id, accounts.id))
    .where(and(...groupConditions))
    .orderBy(asc(entryGroups.date), asc(entryGroups.created_at));

  const realGroups = groups.filter((g) => !isConversion(g.remarks));
  const groupIds = realGroups.map((g) => g.id);

  const lines = groupIds.length
    ? await db
        .select({
          groupId: entries.group_id,
          fromAccountId: entries.from_account_id,
          toAccountId: entries.to_account_id,
          quantity: entries.quantity,
          purity: entries.purity,
          pure: entries.pure_quantity,
          rate: entries.rate,
          remarks: entries.remarks,
          itemType: items.type,
          itemName: items.name,
        })
        .from(entries)
        .innerJoin(items, eq(entries.item_id, items.id))
        .where(inArray(entries.group_id, groupIds))
    : [];

  const linesByGroup = new Map<string, typeof lines>();
  for (const line of lines) {
    const list = linesByGroup.get(line.groupId) ?? [];
    list.push(line);
    linesByGroup.set(line.groupId, list);
  }

  const bills: ReportBill[] = realGroups.map((g) => {
    const groupRate = num(g.ratePerGram);
    const bill: ReportBill = {
      id: g.id,
      date: g.date,
      billNo: g.billNo,
      entryNo: g.entryNo,
      party: g.party,
      items: "",
      ...emptyTotals(),
      tds: num(g.tds),
      tcs: num(g.tcs),
      remarks: g.remarks,
    };

    const itemNames = new Set<string>();

    for (const line of linesByGroup.get(g.id) ?? []) {
      const qty = num(line.quantity);
      // "In" and "out" are always from the shop's side of the ledger.
      const intoShop = line.toAccountId === SYSTEM_ACCOUNTS.SHOP_ID;
      const outOfShop = line.fromAccountId === SYSTEM_ACCOUNTS.SHOP_ID;

      if (line.itemType === "MONEY") {
        const remark = line.remarks || "";
        if (remark === "GST") bill.gst += qty;
        else if (remark === "Discount") bill.discount += qty;
        else if (!isNonPaymentRemark(remark)) {
          // An expense is paid out of CASH/BANK rather than SHOP, so any money
          // leaving towards the party counts as cash out.
          if (intoShop) bill.cashIn += qty;
          else bill.cashOut += qty;
        }
        continue;
      }

      itemNames.add(line.itemName);
      const pure = num(line.pure) || (qty * num(line.purity)) / 100;
      const rate = num(line.rate) || groupRate;
      // A touch-0 line is a direct sale/purchase, valued on weight.
      const value = (pure > 0 ? pure : qty) * rate;

      if (intoShop) {
        bill.weightIn += qty;
        bill.pureIn += pure;
      } else if (outOfShop) {
        bill.weightOut += qty;
        bill.pureOut += pure;
      }
      // Goods value only means something on a sale or purchase; a labour bill or
      // job work moves gold without pricing it line by line.
      if (input.type === "SALE" || input.type === "PURCHASE") bill.amount += value;
    }

    // An expense has no goods — its amount is the money it paid out.
    if (input.type === "EXPENSE") bill.amount = bill.cashOut;

    // GST is the "GST" ledger entry, already counted above. (gstcrm stores no
    // per-bill GST %, so GST-inclusive bills are not estimated.)

    bill.items = Array.from(itemNames).join(", ");
    return roundTotals(bill);
  });

  // Day-wise or month-wise summary.
  const periods = new Map<string, ReportPeriod>();
  for (const bill of bills) {
    const key = periodOf(bill.date, input.group_by);
    let p = periods.get(key);
    if (!p) {
      p = { period: key, bills: 0, ...emptyTotals() };
      periods.set(key, p);
    }
    p.bills += 1;
    addInto(p, bill);
  }

  const totals = { bills: bills.length, ...emptyTotals() };
  for (const bill of bills) addInto(totals, bill);

  return {
    summary: Array.from(periods.values()).map(roundTotals),
    bills,
    totals: roundTotals(totals),
  };
}

// ─── Detailed bill report (every line, charge and payment) ──────────────────

export type DetailedLineSection = "GOLD_ISSUE" | "GOLD_RECEIPT" | "ORNAMENT_ISSUE" | "ORNAMENT_RECEIPT";

export interface DetailedLine {
  item_id: string;
  item_name: string;
  item_type: "GOLD" | "ORNAMENT";
  /** ISSUE = SHOP → party, RECEIPT = party → SHOP. */
  section: DetailedLineSection;
  weight: number;
  touch: number;
  pure: number;
  wastage_weight: number;
  pieces: number;
  rate: number;
  /** Line value on a sale / purchase; 0 on a labour bill / job work. */
  amount: number;
}

export interface DetailedBill {
  id: string;
  date: string;
  entry_no: number | null;
  bill_no: number | null;
  invoice_year_label: string | null;
  invoice_kind: "CASH" | "CREDIT" | null;
  /** Supplier bill no/date on a purchase; voucher no/date on a labour bill / job work. */
  voucher_no: string | null;
  voucher_date: string | null;
  account_id: string;
  party_name: string;
  rate_per_gram: number;
  remarks: string | null;
  goods_amount: number;
  making_charges: number;
  hallmark: number;
  hallmark_gst: number;
  gst: number;
  tds: number;
  tcs: number;
  discount: number;
  /** Signed: positive raises the bill total, negative lowers it. */
  round_off: number;
  cash_paid: number;
  cash_received: number;
  conversion_cash: number;
  conversion_pure: number;
  lines: DetailedLine[];
}

const SECTION_ORDER: Record<DetailedLineSection, number> = {
  GOLD_ISSUE: 0,
  ORNAMENT_ISSUE: 1,
  GOLD_RECEIPT: 2,
  ORNAMENT_RECEIPT: 3,
};

/**
 * Wastage in grams of metal — stored directly on labour / job-work ornament lines,
 * otherwise derived the same way the Labour Bill print does (LabourBillModal).
 */
function wastageGramsOf(line: {
  quantity: string;
  purity: string | null;
  pure: string | null;
  wastageMode: string | null;
  wastageValue: string | null;
  wastageQuantity: string | null;
}): number {
  const direct = num(line.wastageQuantity);
  if (direct > 0) return direct;

  const value = num(line.wastageValue);
  const qty = num(line.quantity);
  const touch = num(line.purity) / 100;
  if (value > 0) {
    if ((line.wastageMode || "PERCENT") === "GRAM") return value;
    const wastagePure = qty * (value / 100);
    return touch > 0 ? wastagePure / touch : wastagePure;
  }

  const pure = num(line.pure);
  const basePure = qty * touch;
  if (pure > basePure && touch > 0) return (pure - basePure) / touch;
  return 0;
}

export async function getDetailedReport(input: DetailedReportInput): Promise<{ bills: DetailedBill[] }> {
  const groupConditions = [
    eq(entryGroups.type, input.type),
    eq(entryGroups.is_deleted, false),
    isNotNull(entryGroups.bill_no),
    gte(entryGroups.date, input.from_date),
    lte(entryGroups.date, input.to_date),
  ];
  if (input.account_id) groupConditions.push(eq(entryGroups.account_id, input.account_id));

  const groups = await db
    .select({
      id: entryGroups.id,
      date: entryGroups.date,
      entryNo: entryGroups.entry_no,
      billNo: entryGroups.bill_no,
      accountId: entryGroups.account_id,
      party: accounts.name,
      ratePerGram: entryGroups.rate_per_gram,
      remarks: entryGroups.remarks,
      tds: entryGroups.tds_amount,
      tcs: entryGroups.tcs_amount,
    })
    .from(entryGroups)
    .innerJoin(accounts, eq(entryGroups.account_id, accounts.id))
    .where(and(...groupConditions))
    .orderBy(asc(entryGroups.date), asc(entryGroups.entry_no), asc(entryGroups.created_at));

  const realGroups = groups.filter((g) => !isConversion(g.remarks));
  const groupIds = realGroups.map((g) => g.id);

  const lines = groupIds.length
    ? await db
        .select({
          groupId: entries.group_id,
          itemId: entries.item_id,
          fromAccountId: entries.from_account_id,
          toAccountId: entries.to_account_id,
          quantity: entries.quantity,
          purity: entries.purity,
          pure: entries.pure_quantity,
          pieces: entries.piece_count,
          wastageMode: entries.wastage_mode,
          wastageValue: entries.wastage_value,
          wastageQuantity: entries.wastage_quantity,
          rate: entries.rate,
          remarks: entries.remarks,
          itemType: items.type,
          itemName: items.name,
        })
        .from(entries)
        .innerJoin(items, eq(entries.item_id, items.id))
        .where(inArray(entries.group_id, groupIds))
        .orderBy(asc(entries.created_at))
    : [];

  const linesByGroup = new Map<string, typeof lines>();
  for (const line of lines) {
    const list = linesByGroup.get(line.groupId) ?? [];
    list.push(line);
    linesByGroup.set(line.groupId, list);
  }

  const isTrade = input.type === "SALE" || input.type === "PURCHASE";
  const shop = SYSTEM_ACCOUNTS.SHOP_ID;

  const bills: DetailedBill[] = realGroups.map((g) => {
    const groupRate = num(g.ratePerGram);
    let goodsAmount = 0;
    let makingCharges = 0;
    let hallmark = 0;
    let hallmarkGst = 0;
    let gst = 0;
    let tdsLines = 0;
    let tcsLines = 0;
    let discount = 0;
    let roundOff = 0;
    let cashPaid = 0;
    let cashReceived = 0;
    let conversionCash = 0;
    let conversionPure = 0;
    const detailLines: DetailedLine[] = [];

    for (const line of linesByGroup.get(g.id) ?? []) {
      const qty = num(line.quantity);
      const intoShop = line.toAccountId === shop;
      const outOfShop = line.fromAccountId === shop;

      if (line.itemType === "MONEY") {
        const remark = line.remarks || "";
        if (remark === "GST") gst += qty;
        else if (remark === "Hallmark") hallmark += qty;
        else if (remark === "Hallmark GST") hallmarkGst += qty;
        else if (remark === "Discount") discount += qty;
        else if (remark === "TDS Adjustment") tdsLines += qty;
        else if (remark === "TCS Adjustment") tcsLines += qty;
        else if (remark === "Round Off") {
          // Positive when it raises the bill: on a purchase that is supplier → SHOP,
          // everywhere else SHOP → party.
          const raises = input.type === "PURCHASE" ? intoShop : outOfShop;
          roundOff += raises ? qty : -qty;
        } else if (remark.startsWith(CASH_CONVERSION_PREFIX)) {
          conversionCash += qty;
          conversionPure += conversionGrams(remark);
        } else if (!isNonPaymentRemark(remark)) {
          if (outOfShop) cashPaid += qty;
          else if (intoShop) cashReceived += qty;
        }
        continue;
      }

      const itemType = line.itemType === "ORNAMENT" ? "ORNAMENT" : "GOLD";
      const touch = num(line.purity);
      const pure = linePure(line);
      const rate = num(line.rate) || groupRate;
      // Purchase lines carry a placeholder wastage % with no defined formula yet —
      // report no wastage for purchases.
      const wastage = input.type === "PURCHASE" ? 0 : wastageGramsOf(line);
      // A touch-0 line is a direct sale/purchase, valued on weight.
      const amount = isTrade ? lineGoodsAmount(line, groupRate) : 0;
      const section: DetailedLineSection = `${itemType}_${intoShop ? "RECEIPT" : "ISSUE"}`;

      goodsAmount += amount;
      // Making charge = wastage on ornaments received back, valued at the rate
      // (same basis the Labour Bill print uses).
      if (!isTrade && section === "ORNAMENT_RECEIPT" && wastage > 0) {
        const wastagePure = (wastage * touch) / 100;
        makingCharges += (wastagePure > 0 ? wastagePure : wastage) * rate;
      }

      detailLines.push({
        item_id: line.itemId,
        item_name: line.itemName,
        item_type: itemType,
        section,
        weight: round3(qty),
        touch: round3(touch),
        pure: round3(pure),
        wastage_weight: round3(wastage),
        pieces: round3(num(line.pieces)),
        rate: round2(rate),
        amount: round2(amount),
      });
    }

    detailLines.sort((a, b) => SECTION_ORDER[a.section] - SECTION_ORDER[b.section]);

    return {
      id: g.id,
      date: g.date,
      entry_no: g.entryNo,
      bill_no: g.billNo,
      // gstcrm has no accounting years, invoice kind or supplier/voucher bill
      // columns — kept in the output so the shape matches goldcrm's.
      invoice_year_label: null,
      invoice_kind: null,
      voucher_no: null,
      voucher_date: null,
      account_id: g.accountId,
      party_name: g.party,
      rate_per_gram: round2(groupRate),
      remarks: g.remarks,
      goods_amount: round2(goodsAmount),
      making_charges: round2(makingCharges),
      hallmark: round2(hallmark),
      hallmark_gst: round2(hallmarkGst),
      gst: round2(gst),
      // The group's saved figure is authoritative; the ledger line is the fallback.
      tds: round2(num(g.tds) || tdsLines),
      tcs: round2(num(g.tcs) || tcsLines),
      discount: round2(discount),
      round_off: round2(roundOff),
      cash_paid: round2(cashPaid),
      cash_received: round2(cashReceived),
      conversion_cash: round2(conversionCash),
      conversion_pure: round3(conversionPure),
      lines: detailLines,
    };
  });

  return { bills };
}

// ─── Bank report ──────────────────────────────────────────────────────────────

export async function getBankReport(input: BankReportInput) {
  // The bank ledger already merges bill payments with manual deposits and
  // transfers and computes running balances — reuse it rather than re-derive.
  const ledger = await getBankLedger({
    bankKey: input.bank_key,
    from_date: input.from_date,
    to_date: input.to_date,
    page: 1,
    limit: Number.MAX_SAFE_INTEGER,
  });

  const rows = [...ledger.log.rows].reverse(); // oldest first for a report

  const periods = new Map<string, { period: string; count: number; credit: number; debit: number }>();
  for (const txn of rows) {
    const key = periodOf(txn.date, input.group_by);
    let p = periods.get(key);
    if (!p) {
      p = { period: key, count: 0, credit: 0, debit: 0 };
      periods.set(key, p);
    }
    p.count += 1;
    if (txn.direction === "CREDIT") p.credit += txn.amount;
    else p.debit += txn.amount;
  }

  return {
    summary: Array.from(periods.values()).map((p) => ({
      ...p,
      credit: round2(p.credit),
      debit: round2(p.debit),
      net: round2(p.credit - p.debit),
    })),
    transactions: rows,
    banks: ledger.banks,
    totals: ledger.grandTotals,
  };
}

// ─── Stock report ─────────────────────────────────────────────────────────────

export async function getStockReport(input: StockReportInput) {
  const shop = SYSTEM_ACCOUNTS.SHOP_ID;

  const baseSelect = {
    itemId: entries.item_id,
    itemName: items.name,
    itemType: items.type,
    fromAccountId: entries.from_account_id,
    toAccountId: entries.to_account_id,
    quantity: entries.quantity,
    purity: entries.purity,
    date: entryGroups.date,
  };

  // Every goods line that touched the shop up to the end of the range. An edited
  // or deleted bill leaves its original soft-deleted plus a REVERSAL group that
  // cancels it; skipping both nets to the same stock and keeps the in/out columns
  // free of movements that never really happened.
  const lines = await db
    .select(baseSelect)
    .from(entries)
    .innerJoin(entryGroups, eq(entries.group_id, entryGroups.id))
    .innerJoin(items, eq(entries.item_id, items.id))
    .where(
      and(
        ne(items.type, "MONEY"),
        eq(entryGroups.is_deleted, false),
        ne(entryGroups.type, "REVERSAL"),
        lte(entryGroups.date, input.to_date),
      ),
    );

  type Row = {
    key: string;
    itemName: string;
    itemType: string;
    touch: string;
    openingWeight: number;
    inWeight: number;
    outWeight: number;
    inPure: number;
    outPure: number;
    openingPure: number;
  };

  const byItem = new Map<string, Row>();
  const periods = new Map<string, { period: string; inWeight: number; outWeight: number; inPure: number; outPure: number }>();

  for (const line of lines) {
    const intoShop = line.toAccountId === shop;
    const outOfShop = line.fromAccountId === shop;
    if (!intoShop && !outOfShop) continue;

    const qty = num(line.quantity);
    const touchNum = num(line.purity);
    const pure = (qty * touchNum) / 100;
    // Gold is held per name AND touch (see getAccountItemTouchBalances);
    // ornaments are one line per item.
    // 3 decimals so 99.999 is not reported as 100.000 — see getAccountItemTouchBalances.
    const touch = line.itemType === "GOLD" ? touchNum.toFixed(3) : "";
    const key = `${line.itemId}::${touch}`;

    let row = byItem.get(key);
    if (!row) {
      row = {
        key,
        itemName: line.itemName,
        itemType: line.itemType,
        touch,
        openingWeight: 0,
        inWeight: 0,
        outWeight: 0,
        inPure: 0,
        outPure: 0,
        openingPure: 0,
      };
      byItem.set(key, row);
    }

    const sign = intoShop ? 1 : -1;
    if (line.date < input.from_date) {
      row.openingWeight += sign * qty;
      row.openingPure += sign * pure;
      continue;
    }

    if (intoShop) {
      row.inWeight += qty;
      row.inPure += pure;
    } else {
      row.outWeight += qty;
      row.outPure += pure;
    }

    const periodKey = periodOf(line.date, input.group_by);
    let p = periods.get(periodKey);
    if (!p) {
      p = { period: periodKey, inWeight: 0, outWeight: 0, inPure: 0, outPure: 0 };
      periods.set(periodKey, p);
    }
    if (intoShop) {
      p.inWeight += qty;
      p.inPure += pure;
    } else {
      p.outWeight += qty;
      p.outPure += pure;
    }
  }

  const items_ = Array.from(byItem.values())
    .map((r) => ({
      itemName: r.itemName,
      itemType: r.itemType,
      touch: r.touch,
      openingWeight: round3(r.openingWeight),
      inWeight: round3(r.inWeight),
      outWeight: round3(r.outWeight),
      closingWeight: round3(r.openingWeight + r.inWeight - r.outWeight),
      openingPure: round3(r.openingPure),
      inPure: round3(r.inPure),
      outPure: round3(r.outPure),
      closingPure: round3(r.openingPure + r.inPure - r.outPure),
    }))
    // Drop lines with no stock and no movement in the range — pure noise.
    .filter(
      (r) =>
        r.openingWeight !== 0 || r.inWeight !== 0 || r.outWeight !== 0 || r.closingWeight !== 0,
    )
    .sort((a, b) =>
      a.itemType === b.itemType
        ? a.itemName.localeCompare(b.itemName) || a.touch.localeCompare(b.touch)
        : a.itemType.localeCompare(b.itemType),
    );

  return {
    summary: Array.from(periods.values())
      .sort((a, b) => a.period.localeCompare(b.period))
      .map((p) => ({
        period: p.period,
        inWeight: round3(p.inWeight),
        outWeight: round3(p.outWeight),
        inPure: round3(p.inPure),
        outPure: round3(p.outPure),
      })),
    items: items_,
  };
}

