import { AppError } from "@/types/errors";
import { createEntryGroup } from "@/lib/entryBuilder";
import { reverseEntryGroup } from "@/lib/reversal";
import {
  toDecimal,
  toQuantityString,
} from "@/lib/decimal";
import { getLotBalances, getAggregateBalances, getBatchAggregateBalances } from "@/lib/balance";
import { SYSTEM_ACCOUNTS, SYSTEM_ITEMS } from "@/config/constants";
import {
  listTransactions,
  getTransactionById,
} from "@/lib/transactionQueries";
import { db } from "@/db";
import { entries as entriesTable, items as itemsTable, entryGroups, labourBillCycles, accounts } from "@/db/schema";
import { inArray, eq, and, max, desc, sql, not, isNotNull } from "drizzle-orm";
import type { z } from "zod";
import {
  CreateLabourBillSchema,
  UpdateLabourBillSchema,
  type ListTxSchema,
  type GetByIdSchema,
  type DeleteTxSchema,
  type CreateCycleSchema,
  type ListCyclesSchema,
  type GetCycleDetailSchema,
  type ConvertGoldToCashSchema,
  type ConvertCashToGoldSchema,
  type ReceiveCashSchema,
} from "./schema";

// ─── Wastage formula for Labour Bill ornament items ───────────────────────────
// wastage_gm = (weight × wastage_percent/100) / (touch/100)
// gross_weight = weight + wastage_gm
// pure = gross_weight × (touch / 100)
function calcOrnamentEntry(item: {
  quantity: string;
  purity: string;
  stone?: string;
  throde?: string;
  chain?: string;
  wastage_percent: string;
}): { grossWeight: string; pureQuantity: string; wastageGm: string } {
  const weight = toDecimal(item.quantity);
  const touch = toDecimal(item.purity).div(100);
  const wastagePercent = toDecimal(item.wastage_percent).div(100);

  // wastage_gm = (weight × wastage%) / touch
  const wastageGm = touch.gt(0)
    ? weight.mul(wastagePercent).div(touch)
    : toDecimal("0");

  const grossWeight = weight.plus(wastageGm);
  const pureQuantity = grossWeight.mul(touch);

  return {
    grossWeight: toQuantityString(grossWeight),
    pureQuantity: toQuantityString(pureQuantity),
    wastageGm: toQuantityString(wastageGm),
  };
}

// ─── createCycle ─────────────────────────────────────────────────────────────
// Creates a new bill cycle (permanent ledger book) for a goldsmith.
// The bill_no is auto-incremented per-account (1, 2, 3…).

export async function createCycle(input: z.infer<typeof CreateCycleSchema>) {
  return db.transaction(async (tx) => {
    // Lock the account row to serialize bill_no generation for this account
    await tx.execute(
      sql`SELECT id FROM ${accounts} WHERE id = ${input.account_id} FOR UPDATE`
    );

    // Use MAX(bill_no) + 1 per account
    const [row] = await tx
      .select({ max: max(labourBillCycles.bill_no) })
      .from(labourBillCycles)
      .where(eq(labourBillCycles.account_id, input.account_id));

    const nextBillNo = (row?.max ?? 0) + 1;

    const [cycle] = await tx
      .insert(labourBillCycles)
      .values({
        account_id: input.account_id,
        bill_no: nextBillNo,
        main_reason: input.main_reason ?? null,
      })
      .returning();

    if (!cycle) throw new AppError("INTERNAL_ERROR", "Failed to create bill cycle");
    return cycle;
  });
}

// ─── listCycles ───────────────────────────────────────────────────────────────
// Returns all bill cycles for a goldsmith, ordered by bill_no ascending.

export async function listCycles(input: z.infer<typeof ListCyclesSchema>) {
  const cycles = await db
    .select()
    .from(labourBillCycles)
    .where(eq(labourBillCycles.account_id, input.account_id))
    .orderBy(desc(labourBillCycles.bill_no));

  return cycles;
}

// ─── getCycleDetail ───────────────────────────────────────────────────────────
// Returns a bill cycle + all its entry groups + entries, for drill-down view.

export async function getCycleDetail(input: z.infer<typeof GetCycleDetailSchema>) {
  // 1. Fetch the cycle record
  const [cycle] = await db
    .select()
    .from(labourBillCycles)
    .where(eq(labourBillCycles.id, input.cycle_id))
    .limit(1);

  if (!cycle) throw new AppError("NOT_FOUND", "Bill cycle not found");

  // 2. Fetch all non-deleted entry groups that belong to this cycle
  const groups = await db
    .select({
      group: entryGroups,
    })
    .from(entryGroups)
    .where(
      and(
        eq(entryGroups.bill_cycle_id, input.cycle_id),
        eq(entryGroups.is_deleted, false),
      )
    )
    .orderBy(entryGroups.created_at);

  if (groups.length === 0) {
    return { cycle, groups: [] };
  }

  // 3. Fetch all entries for those groups
  const groupIds = groups.map((g) => g.group.id);
  const txEntries = await db
    .select({
      entry: entriesTable,
      item_name: itemsTable.name,
      item_type: itemsTable.type,
    })
    .from(entriesTable)
    .leftJoin(itemsTable, eq(entriesTable.item_id, itemsTable.id))
    .where(inArray(entriesTable.group_id, groupIds));

  // 4. Join entries back to groups
  const entryMap = new Map<string, typeof txEntries>();
  for (const e of txEntries) {
    const gId = e.entry.group_id;
    if (!entryMap.has(gId)) entryMap.set(gId, []);
    entryMap.get(gId)!.push(e);
  }

  const enrichedGroups = groups.map((g) => ({
    ...g,
    entries: entryMap.get(g.group.id) ?? [],
  }));

  return { cycle, groups: enrichedGroups };
}

// ─── listLabourBills ──────────────────────────────────────────────────────────

export async function listLabourBills(input: z.infer<typeof ListTxSchema>) {
  const result = await listTransactions("LABOUR_BILL", input);

  if (result.data.length === 0) return result;

  // Batch-fetch all entries for the returned groups (same pattern as listPurchases)
  const groupIds = result.data.map((d) => d.group.id);
  const txEntries = await db
    .select({
      entry: entriesTable,
      item_name: itemsTable.name,
      item_type: itemsTable.type,
    })
    .from(entriesTable)
    .leftJoin(itemsTable, eq(entriesTable.item_id, itemsTable.id))
    .where(inArray(entriesTable.group_id, groupIds));

  // Batch-fetch opening balances in a single query
  const tuples = result.data.map((d) => ({
    id: d.group.id,
    accountId: d.group.account_id,
    createdAt: new Date(d.group.created_at),
    excludeGroupId: d.group.id,
  }));
  const batchBalances = await getBatchAggregateBalances(tuples);

  // Attach entries + compute opening balance per group
  const finalData = result.data.map((d) => {
    const groupEntries = txEntries.filter(
      (e) => e.entry.group_id === d.group.id,
    );

    const opening = batchBalances[d.group.id]!;

    return {
      ...d,
      entries: groupEntries,
      openingPure: opening.totalPure.toFixed(4),
      openingCash: opening.totalCash.toFixed(2),
    };
  });

  return { ...result, data: finalData };
}

// ─── getLabourBillById ────────────────────────────────────────────────────────

export async function getLabourBillById(input: z.infer<typeof GetByIdSchema>) {
  const tx = await getTransactionById(input.id);
  if (!tx) throw new AppError("NOT_FOUND", "Labour bill not found");

  const opening = await getAggregateBalances(
    tx.group.account_id,
    new Date(tx.group.created_at),
    tx.group.id
  );

  const [lastGroup] = await db
    .select({ rate_per_gram: entryGroups.rate_per_gram })
    .from(entryGroups)
    .where(
      and(
        eq(entryGroups.account_id, tx.group.account_id),
        eq(entryGroups.is_deleted, false),
        not(eq(entryGroups.type, "REVERSAL")),
        isNotNull(entryGroups.rate_per_gram),
        sql`created_at < ${new Date(tx.group.created_at).toISOString()}`
      )
    )
    .orderBy(desc(entryGroups.created_at))
    .limit(1);

  return {
    ...tx,
    openingPure: opening.balancePure.toString(),
    openingCash: opening.totalCash.toString(),
    lastRate: lastGroup?.rate_per_gram || "0"
  };
}

// ─── createLabourBill ─────────────────────────────────────────────────────────

export async function createLabourBill(
  input: z.infer<typeof CreateLabourBillSchema>,
  options?: { existingBillNo?: number; existingEntryNo?: number }
) {
  // ── Always validate input regardless of call path (tRPC or direct) ──────────
  const validated = CreateLabourBillSchema.parse(input);
  const safeInput = { ...input, ...validated };

  // ── Bill cycle is mandatory ──────────────────────────────────────────────────
  // A labour bill must always live inside a cycle. If bill_cycle_id is missing the
  // entry builder falls back to auto-numbering bill_no (MAX+1), producing a phantom
  // "bill" that maps to no real cycle. Guard here so BOTH the tRPC create path and
  // the update path (which recreates via this function) are covered.
  if (!input.bill_cycle_id) {
    throw new AppError(
      "VALIDATION_ERROR",
      "A bill cycle must be selected before saving a labour bill.",
    );
  }
  const [cycle] = await db
    .select({ bill_no: labourBillCycles.bill_no, account_id: labourBillCycles.account_id })
    .from(labourBillCycles)
    .where(eq(labourBillCycles.id, input.bill_cycle_id))
    .limit(1);
  if (!cycle) {
    throw new AppError("NOT_FOUND", "Selected bill cycle does not exist.");
  }
  if (cycle.account_id !== input.account_id) {
    throw new AppError(
      "BUSINESS_RULE_VIOLATION",
      "Selected bill cycle belongs to a different goldsmith.",
    );
  }
  const cycleBillNo: number = cycle.bill_no;

  const entries: Parameters<typeof createEntryGroup>[0]["entries"] = [];

  // ── 1. Gold Issue: SHOP → Goldsmith ────────────────────────────────────────
  for (const item of input.gold_issue) {
    // Only check stock if a specific lot was provided
    if (item.lot_id) {
      const lots = await getLotBalances(SYSTEM_ACCOUNTS.SHOP_ID, item.item_id);
      const activeLot = lots.find((l) => l.lot_id === item.lot_id);
      const available = activeLot?.quantity ?? toDecimal("0");

      // Sign convention allows negative stock for goldsmith issues: if stock is 0/insufficient we can give gold
      /*
      if (available.lt(toDecimal(item.quantity))) {
        throw new AppError(
          "BUSINESS_RULE_VIOLATION",
          `Insufficient stock for gold issue item ${item.item_id} in lot ${item.lot_id}`,
        );
      }
      */
    }

    entries.push({
      fromAccountId: SYSTEM_ACCOUNTS.SHOP_ID,
      toAccountId: input.account_id,
      itemId: item.item_id,
      lotId: item.lot_id,
      quantity: item.quantity,
      purity: item.purity,
    });
  }

  // ── 2. Ornament Issue: SHOP → Goldsmith (with wastage) ─────────────────────
  for (const item of input.ornament_issue) {
    const { grossWeight, wastageGm } = calcOrnamentEntry(item);

    if (item.lot_id) {
      const lots = await getLotBalances(SYSTEM_ACCOUNTS.SHOP_ID, item.item_id);
      const activeLot = lots.find((l) => l.lot_id === item.lot_id);
      const available = activeLot?.quantity ?? toDecimal("0");

      // Sign convention allows negative stock for goldsmith issues: if stock is 0/insufficient we can give gold
      /*
      if (available.lt(toDecimal(grossWeight))) {
        throw new AppError(
          "BUSINESS_RULE_VIOLATION",
          `Insufficient stock for ornament issue item ${item.item_id} in lot ${item.lot_id}`,
        );
      }
      */
    }

    entries.push({
      fromAccountId: SYSTEM_ACCOUNTS.SHOP_ID,
      toAccountId: input.account_id,
      itemId: item.item_id,
      lotId: item.lot_id,
      quantity: grossWeight,       // full gross weight (including wastage)
      purity: item.purity,
      wastageMode: "PERCENT",
      wastageValue: item.wastage_percent,
      // grossWeight already includes wastage, so it must NOT be used as the base for
      // recomputing wastage_quantity (that would re-apply wastage% on top of an
      // already-inflated weight). Override with the correctly-derived amount instead.
      wastageQuantity: wastageGm,
    });
  }

  // ── 3. Gold Receipt: Goldsmith → SHOP ──────────────────────────────────────
  for (const item of input.gold_receipt) {
    entries.push({
      fromAccountId: input.account_id,
      toAccountId: SYSTEM_ACCOUNTS.SHOP_ID,
      itemId: item.item_id,
      lotId: item.lot_id, // optional on receipts
      quantity: item.quantity,
      purity: item.purity,
    });
  }

  // ── 4. Ornament Receipt: Goldsmith → SHOP ──────────────────────────────────
  // KEY DESIGN: The physical ornament weight (item.quantity) is stored as the
  // ledger quantity — this is what appears in the shop's stock lot.
  // e.g. a 40g ring → stock shows 40g, NOT 43.556g (40g + 3.556g wastage).
  //
  // However, the goldsmith's balance must decrease by the FULL gold consumed:
  //   grossPure = (physicalWeight + wastageGm) × touch%
  // We pass this as a pureQuantity override so the balance is correct without
  // inflating the stock lot weight.
  //
  // entryBuilder then computes:
  //   averageTouch = grossPure / physicalWeight × 100  (e.g. 98%)
  for (const item of input.ornament_receipt) {
    const { pureQuantity: grossPure, wastageGm } = calcOrnamentEntry(item);

    entries.push({
      fromAccountId: input.account_id,
      toAccountId: SYSTEM_ACCOUNTS.SHOP_ID,
      itemId: item.item_id,
      lotId: item.lot_id,
      // Physical weight of the ornament (user entered 40g → stock lot shows 40g)
      quantity: item.quantity,
      purity: item.purity,
      // Override: total pure gold consumed = (physicalWeight + wastageGm) × touch%
      // Goldsmith's gold balance decreases by this full amount, not just physical × touch%.
      pureQuantity: grossPure,
      // Record the wastage % and derived gram amount so history/reporting shows the
      // real wastage instead of blank/zero (quantity here is already the physical
      // base weight, so this matches what calcOrnamentEntry used to build grossPure).
      wastageMode: "PERCENT",
      wastageValue: item.wastage_percent,
      wastageQuantity: wastageGm,
    });
  }

  // ── 5. Bank Paid: SHOP pays Goldsmith (cash out from SHOP) ─────────────────
  if (input.bank_paid && toDecimal(input.bank_paid).gt(0)) {
    entries.push({
      fromAccountId: SYSTEM_ACCOUNTS.SHOP_ID,
      toAccountId: input.account_id,
      itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID,
      quantity: input.bank_paid,
      remarks: input.bank_paid_details,
    });
  }

  // ── 6. Bank Receive: Goldsmith pays SHOP (cash in to SHOP) ─────────────────
  if (input.bank_receive && toDecimal(input.bank_receive).gt(0)) {
    entries.push({
      fromAccountId: input.account_id,
      toAccountId: SYSTEM_ACCOUNTS.SHOP_ID,
      itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID,
      quantity: input.bank_receive,
      remarks: input.bank_receive_details,
    });
  }

  // ── 6.5. Discount ──────────────────────────────────────────────────────────
  if (input.discount && toDecimal(input.discount).gt(0)) {
    entries.push({
      fromAccountId: SYSTEM_ACCOUNTS.SHOP_ID,
      toAccountId: input.account_id,
      itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID,
      quantity: input.discount,
      remarks: "Discount",
    });
  }

  // ── 6.6. TDS — subtracts from what the goldsmith owes (SHOP → goldsmith,
  // same direction/effect as a discount). ──────────────────────────────────
  if (input.tds_enabled && input.tds_amount && toDecimal(input.tds_amount).gt(0)) {
    entries.push({
      fromAccountId: SYSTEM_ACCOUNTS.SHOP_ID,
      toAccountId: input.account_id,
      itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID,
      quantity: input.tds_amount,
      remarks: "TDS Adjustment",
    });
  }

  // ── 6.7. TCS — adds to what the goldsmith owes (goldsmith → SHOP). ───────
  if (input.tcs_enabled && input.tcs_amount && toDecimal(input.tcs_amount).gt(0)) {
    entries.push({
      fromAccountId: input.account_id,
      toAccountId: SYSTEM_ACCOUNTS.SHOP_ID,
      itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID,
      quantity: input.tcs_amount,
      remarks: "TCS Adjustment",
    });
  }

  // ── 7. Partial Cash Conversions ─────────────────────────────────────────────
  // Each conversion records that the goldsmith now owes cash instead of pure gold.
  // The goldsmith sends cash_amount worth of their gold debt to SHOP as a MONEY entry.
  for (const conversion of input.cash_conversions) {
    if (toDecimal(conversion.cash_amount).gt(0)) {
      entries.push({
        fromAccountId: input.account_id,
        toAccountId: SYSTEM_ACCOUNTS.SHOP_ID,
        itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID,
        quantity: conversion.cash_amount,
        remarks: `Cash conversion: ${conversion.gold_grams}g @ ₹${conversion.rate_per_gram}/g`,
      });
    }
  }

  // Guard: must have at least one entry
  if (entries.length === 0) {
    throw new AppError("VALIDATION_ERROR", "Labour bill must have at least one entry");
  }

  const { group, entries: created } = await createEntryGroup({
    type: "LABOUR_BILL",
    accountId: input.account_id,
    date: input.date,
    billNo: cycleBillNo, // always the real cycle's bill_no (guarded above)
    entryNo: options?.existingEntryNo,
    ratePerGram: input.rate_per_gram,
    remarks: input.remarks,
    billCycleId: input.bill_cycle_id,
    tdsAmount: input.tds_amount,
    tcsAmount: input.tcs_amount,
    entries,
  });

  return { group, entries: created };
}

// ─── updateLabourBill ─────────────────────────────────────────────────────────

export async function updateLabourBill(input: z.infer<typeof UpdateLabourBillSchema>) {
  // ── Always validate input regardless of call path (tRPC or direct) ──────────
  UpdateLabourBillSchema.parse(input);

  const [originalGroup] = await db
    .select({
      bill_no: entryGroups.bill_no,
      entry_no: entryGroups.entry_no,
    })
    .from(entryGroups)
    .where(eq(entryGroups.id, input.id))
    .limit(1);

  if (!originalGroup) {
    throw new AppError("NOT_FOUND", "Labour bill not found");
  }

  await reverseEntryGroup(input.id);
  const { id: _removed, ...createInput } = input;
  return createLabourBill(createInput, {
    existingBillNo: originalGroup.bill_no ?? undefined,
    existingEntryNo: originalGroup.entry_no ?? undefined,
  });
}

// ─── deleteLabourBill ─────────────────────────────────────────────────────────

export async function deleteLabourBill(input: z.infer<typeof DeleteTxSchema>) {
  throw new AppError("BUSINESS_RULE_VIOLATION", "Delete option has been disabled for labour bills");
}

// ─── convertGoldToCash ────────────────────────────────────────────────────────
// Converts part of a goldsmith's carried-forward OPENING gold balance into a
// cash debt, independent of any bill currently being drafted — the Labour Bill
// equivalent of Purchase's convertGoldToCash. Same RUPEE_ITEM_ID + SHOP_ID
// trick (no real gold moves, only the balance is reclassified).
//
// Sign convention (verified against getAggregateBalances directly — a Gold
// Issue is SHOP → goldsmith, an inflow for the goldsmith's own account, so
// totalPure is already positive when the goldsmith owes gold; no negation).
// openingPureNum shown on the form = totalPure, positive = goldsmith owes
// shop, negative = shop owes goldsmith. Works in EITHER direction: a positive
// gold balance converts to a positive cash balance (goldsmith owes shop cash
// instead of gold); a negative gold balance converts to a negative cash
// balance (shop owes goldsmith cash instead of gold) — both entries below
// simply flip direction when the balance is negative, so the conversion always
// shrinks the gold magnitude and grows the cash magnitude in the same sign.
export async function convertGoldToCash(input: z.infer<typeof ConvertGoldToCashSchema>) {
  const goldGrams = toDecimal(input.gold_grams);
  const cashAmount = goldGrams.times(toDecimal(input.rate_per_gram));

  const opening = await getAggregateBalances(input.account_id);
  const openingPure = toDecimal(opening.totalPure.toFixed(3)); // positive = goldsmith owes shop, negative = shop owes goldsmith

  if (openingPure.eq(0)) {
    throw new AppError("BUSINESS_RULE_VIOLATION", "This goldsmith has no outstanding gold balance to convert.");
  }
  const availablePure = openingPure.abs();
  if (goldGrams.gt(availablePure.plus(0.001))) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Cannot convert ${goldGrams.toFixed(3)}g — only ${availablePure.toFixed(3)}g of gold is outstanding for this goldsmith.`,
    );
  }

  const today = new Date().toISOString().split("T")[0]!;
  const label = `Gold to Cash Conversion (${goldGrams.toFixed(3)}g @ ₹${toDecimal(input.rate_per_gram).toFixed(2)}/g)`;
  const isPositive = openingPure.gt(0);

  const { group, entries } = await createEntryGroup({
    type: "LABOUR_BILL",
    accountId: input.account_id,
    date: today,
    ratePerGram: input.rate_per_gram,
    remarks: label,
    skipBillNo: true,
    entries: [
      {
        // Shrinks the gold magnitude toward zero (whichever side owes it)
        fromAccountId: isPositive ? input.account_id : SYSTEM_ACCOUNTS.SHOP_ID,
        toAccountId: isPositive ? SYSTEM_ACCOUNTS.SHOP_ID : input.account_id,
        itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID,
        quantity: "0",
        pureQuantity: goldGrams.toFixed(3),
        remarks: label,
      },
      {
        // Grows a cash debt of matching magnitude on the same side
        fromAccountId: isPositive ? SYSTEM_ACCOUNTS.SHOP_ID : input.account_id,
        toAccountId: isPositive ? input.account_id : SYSTEM_ACCOUNTS.SHOP_ID,
        itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID,
        quantity: cashAmount.toFixed(2),
        remarks: label,
      },
    ],
  });

  return { group, entries };
}

// ─── convertCashToGold ────────────────────────────────────────────────────────
// The opposite of convertGoldToCash: converts part of a goldsmith's outstanding
// cash debt into a pure-gold debt, at an agreed rate. Works in either sign
// direction — see convertGoldToCash's comment for the full explanation.
export async function convertCashToGold(input: z.infer<typeof ConvertCashToGoldSchema>) {
  const cashAmount = toDecimal(input.cash_amount);
  const rate = toDecimal(input.rate_per_gram);
  const goldGrams = cashAmount.div(rate);

  const opening = await getAggregateBalances(input.account_id);
  const openingCash = toDecimal(opening.totalCash.toFixed(2)); // positive = goldsmith owes shop, negative = shop owes goldsmith

  if (openingCash.eq(0)) {
    throw new AppError("BUSINESS_RULE_VIOLATION", "This goldsmith has no outstanding cash balance to convert.");
  }
  const availableCash = openingCash.abs();
  if (cashAmount.gt(availableCash.plus(0.01))) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Cannot convert ₹${cashAmount.toFixed(2)} — only ₹${availableCash.toFixed(2)} of cash is outstanding for this goldsmith.`,
    );
  }

  const today = new Date().toISOString().split("T")[0]!;
  const label = `Cash to Gold Conversion (${goldGrams.toFixed(3)}g @ ₹${toDecimal(input.rate_per_gram).toFixed(2)}/g)`;
  const isPositive = openingCash.gt(0);

  const { group, entries } = await createEntryGroup({
    type: "LABOUR_BILL",
    accountId: input.account_id,
    date: today,
    ratePerGram: input.rate_per_gram,
    remarks: label,
    skipBillNo: true,
    entries: [
      {
        // Shrinks the cash magnitude toward zero (whichever side owes it)
        fromAccountId: isPositive ? input.account_id : SYSTEM_ACCOUNTS.SHOP_ID,
        toAccountId: isPositive ? SYSTEM_ACCOUNTS.SHOP_ID : input.account_id,
        itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID,
        quantity: cashAmount.toFixed(2),
        remarks: label,
      },
      {
        // Grows a gold debt of matching magnitude on the same side
        fromAccountId: isPositive ? SYSTEM_ACCOUNTS.SHOP_ID : input.account_id,
        toAccountId: isPositive ? input.account_id : SYSTEM_ACCOUNTS.SHOP_ID,
        itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID,
        quantity: "0",
        pureQuantity: goldGrams.toFixed(3),
        remarks: label,
      },
    ],
  });

  return { group, entries };
}

// ─── receiveCash ────────────────────────────────────────────────────────────
// A standalone cash payment FROM the goldsmith TO the shop, independent of any
// bill/cycle — same "no bill_cycle_id required" pattern as the gold/cash
// conversions above (goes straight through createEntryGroup, skipBillNo).
// Direction: goldsmith → SHOP, same as the bank_receive field inside a full
// labour bill — a repayment, so it LOWERS what the goldsmith owes (confirmed
// against a real ledger trace; see LabourBillContext's cashIn/cashOut).
export async function receiveCash(input: z.infer<typeof ReceiveCashSchema>) {
  const amount = toDecimal(input.amount);
  const label = input.details || "Cash";

  const { group, entries } = await createEntryGroup({
    type: "LABOUR_BILL",
    accountId: input.account_id,
    date: input.date,
    remarks: `Cash Received (${label})`,
    skipBillNo: true,
    entries: [
      {
        fromAccountId: input.account_id,
        toAccountId: SYSTEM_ACCOUNTS.SHOP_ID,
        itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID,
        quantity: amount.toFixed(2),
        remarks: label,
      },
    ],
  });

  return { group, entries };
}
