import { AppError } from "@/types/errors";
import { createEntryGroup } from "@/lib/entryBuilder";
import { reverseEntryGroup } from "@/lib/reversal";
import {
  calcWastagePercent,
  calcWastageGram,
  calcTotalWeight,
  calcTotalPure,
  subtractDecimals,
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
import { entryGroups, entries as entriesTable, items as itemsTable } from "@/db/schema";
import { eq, inArray } from "drizzle-orm";
import type { z } from "zod";
import type {
  ListTxSchema,
  GetByIdSchema,
  CreateJobWorkSchema,
  UpdateJobWorkSchema,
  DeleteTxSchema,
} from "./schema";

export async function listJobWork(input: z.infer<typeof ListTxSchema>) {
  const result = await listTransactions("JOB_WORK", input);

  if (result.data.length === 0) return result;

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

export async function getJobWorkById(input: z.infer<typeof GetByIdSchema>) {
  const tx = await getTransactionById(input.id);
  if (!tx) throw new AppError("NOT_FOUND", "Job work not found");

  // Split entries into 4 arrays per plan §12.5
  const goldIssue = tx.entries.filter(
    (e) => e.item_type === "GOLD" && e.entry.from_account_id === SYSTEM_ACCOUNTS.SHOP_ID,
  );
  const goldReceipt = tx.entries.filter(
    (e) => e.item_type === "GOLD" && e.entry.to_account_id === SYSTEM_ACCOUNTS.SHOP_ID,
  );
  const ornamentIssue = tx.entries.filter(
    (e) => e.item_type === "ORNAMENT" && e.entry.from_account_id === SYSTEM_ACCOUNTS.SHOP_ID,
  );
  const ornamentReceipt = tx.entries.filter(
    (e) => e.item_type === "ORNAMENT" && e.entry.to_account_id === SYSTEM_ACCOUNTS.SHOP_ID,
  );

  return { ...tx, goldIssue, goldReceipt, ornamentIssue, ornamentReceipt };
}

// ─── Process ornament item per plan §12.5 Step 1 ─────────────────────────────

function processOrnamentItem(item: {
  quantity: string;
  purity: string;
  stone?: string;
  throde?: string;
  chain?: string;
  wastage_mode: "PERCENT" | "GRAM";
  wastage_value: string;
}) {
  const stone = item.stone ?? "0";
  const throde = item.throde ?? "0";

  // base_weight = quantity - stone - throde
  const base_weight = toQuantityString(
    subtractDecimals(toQuantityString(subtractDecimals(item.quantity, stone)), throde),
  );

  if (item.wastage_mode === "PERCENT" && toDecimal(item.purity).lte(0)) {
    throw new AppError(
      "BUSINESS_RULE_VIOLATION",
      "Purity must be greater than zero when using PERCENT wastage mode"
    );
  }

  const wastageQty =
    item.wastage_mode === "PERCENT"
      ? calcWastagePercent(base_weight, item.wastage_value, item.purity)
      : calcWastageGram(base_weight, item.wastage_value);

  // total_weight = calcTotalWeight(quantity, stone, throde, wastageQty)
  const total_weight = calcTotalWeight(
    item.quantity,
    stone,
    throde,
    toQuantityString(wastageQty),
  );

  return {
    totalWeightStr: toQuantityString(total_weight),
    wastageQtyStr: toQuantityString(wastageQty),
  };
}

export async function createJobWork(
  input: z.infer<typeof CreateJobWorkSchema>,
  options?: { existingBillNo?: number; existingEntryNo?: number }
) {
  // Validate stock for all issues
  for (const item of input.gold_issue) {
    if (!item.lot_id) throw new AppError("VALIDATION_ERROR", "Lot ID is required for gold issue");
    const lots = await getLotBalances(SYSTEM_ACCOUNTS.SHOP_ID, item.item_id);
    const activeLot = lots.find((l) => l.lot_id === item.lot_id);
    const available = activeLot?.quantity ?? toDecimal("0");
    // Sign convention allows negative stock for employee issues: if stock is 0/insufficient we can give gold
    /*
    if (available.lt(toDecimal(item.quantity))) {
      throw new AppError("BUSINESS_RULE_VIOLATION", `Insufficient stock for gold issue item ${item.item_id} in lot ${item.lot_id}`);
    }
    */
  }

  for (const item of input.ornament_issue) {
    if (!item.lot_id) throw new AppError("VALIDATION_ERROR", "Lot ID is required for ornament issue");
    const lots = await getLotBalances(SYSTEM_ACCOUNTS.SHOP_ID, item.item_id);
    const activeLot = lots.find((l) => l.lot_id === item.lot_id);
    const available = activeLot?.quantity ?? toDecimal("0");
    const { totalWeightStr } = processOrnamentItem(item);
    // Sign convention allows negative stock for employee issues: if stock is 0/insufficient we can give gold
    /*
    if (available.lt(toDecimal(totalWeightStr))) {
      throw new AppError("BUSINESS_RULE_VIOLATION", `Insufficient stock for ornament issue item ${item.item_id} in lot ${item.lot_id}`);
    }
    */
  }

  const entries: Parameters<typeof createEntryGroup>[0]["entries"] = [];

  // Gold issue: SHOP → goldsmith
  for (const item of input.gold_issue) {
    entries.push({
      fromAccountId: SYSTEM_ACCOUNTS.SHOP_ID,
      toAccountId: input.account_id,
      itemId: item.item_id,
      lotId: item.lot_id,
      quantity: item.quantity,
      purity: item.purity,
    });
  }

  // Ornament issue: SHOP → goldsmith (with wastage calcs)
  for (const item of input.ornament_issue) {
    const { totalWeightStr, wastageQtyStr } = processOrnamentItem(item);
    entries.push({
      fromAccountId: SYSTEM_ACCOUNTS.SHOP_ID,
      toAccountId: input.account_id,
      itemId: item.item_id,
      lotId: item.lot_id,
      quantity: totalWeightStr,
      purity: item.purity,
      wastageMode: item.wastage_mode,
      wastageValue: item.wastage_value,
    });
    // Wastage entry to LOSS account
    entries.push({
      fromAccountId: input.account_id,
      toAccountId: SYSTEM_ACCOUNTS.LOSS_ID,
      itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID, // Should be gold item — set per call site
      quantity: wastageQtyStr,
    });
  }

  // Gold receipt: goldsmith → SHOP
  for (const item of input.gold_receipt) {
    entries.push({
      fromAccountId: input.account_id,
      toAccountId: SYSTEM_ACCOUNTS.SHOP_ID,
      itemId: item.item_id,
      quantity: item.quantity,
      purity: item.purity,
    });
  }

  // Ornament receipt: goldsmith → SHOP (with wastage calcs)
  for (const item of input.ornament_receipt) {
    const { totalWeightStr } = processOrnamentItem(item);
    entries.push({
      fromAccountId: input.account_id,
      toAccountId: SYSTEM_ACCOUNTS.SHOP_ID,
      itemId: item.item_id,
      quantity: totalWeightStr,
      purity: item.purity,
      wastageMode: item.wastage_mode,
      wastageValue: item.wastage_value,
    });
  }

  const { group, entries: created } = await createEntryGroup({
    type: "JOB_WORK",
    accountId: input.account_id,
    date: input.date,
    billNo: options?.existingBillNo,
    entryNo: options?.existingEntryNo,
    remarks: input.remarks,
    entries,
  });

  return { group, entries: created };
}

export async function updateJobWork(input: z.infer<typeof UpdateJobWorkSchema>) {
  const [originalGroup] = await db
    .select({
      bill_no: entryGroups.bill_no,
      entry_no: entryGroups.entry_no,
    })
    .from(entryGroups)
    .where(eq(entryGroups.id, input.id))
    .limit(1);

  if (!originalGroup) {
    throw new AppError("NOT_FOUND", "Job work not found");
  }

  await reverseEntryGroup(input.id);
  const { id: _removed, ...createInput } = input;
  return createJobWork(createInput, {
    existingBillNo: originalGroup.bill_no ?? undefined,
    existingEntryNo: originalGroup.entry_no ?? undefined,
  });
}

export async function deleteJobWork(input: z.infer<typeof DeleteTxSchema>) {
  throw new AppError("BUSINESS_RULE_VIOLATION", "Delete option has been disabled for job work");
}
