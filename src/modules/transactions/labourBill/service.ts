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
import { entries as entriesTable, items as itemsTable, entryGroups } from "@/db/schema";
import { inArray, eq } from "drizzle-orm";
import type { z } from "zod";
import type {
  ListTxSchema,
  GetByIdSchema,
  CreateLabourBillSchema,
  UpdateLabourBillSchema,
  DeleteTxSchema,
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
  return tx;
}

// ─── createLabourBill ─────────────────────────────────────────────────────────

export async function createLabourBill(
  input: z.infer<typeof CreateLabourBillSchema>,
  options?: { existingBillNo?: number; existingEntryNo?: number }
) {
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
    const { grossWeight } = calcOrnamentEntry(item);

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
    const { pureQuantity: grossPure } = calcOrnamentEntry(item);

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
    billNo: options?.existingBillNo,
    entryNo: options?.existingEntryNo,
    ratePerGram: input.rate_per_gram,
    remarks: input.remarks,
    entries,
  });

  return { group, entries: created };
}

// ─── updateLabourBill ─────────────────────────────────────────────────────────

export async function updateLabourBill(input: z.infer<typeof UpdateLabourBillSchema>) {
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
