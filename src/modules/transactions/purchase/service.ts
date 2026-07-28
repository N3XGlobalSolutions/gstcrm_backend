import { AppError } from "@/types/errors";
import { createEntryGroup } from "@/lib/entryBuilder";
import { reverseEntryGroup } from "@/lib/reversal";
import { toQuantityString, toDecimal } from "@/lib/decimal";
import { SYSTEM_ACCOUNTS, SYSTEM_ITEMS } from "@/config/constants";
import { listTransactions, getTransactionById, generateBillNo } from "@/lib/transactionQueries";
import { db } from "@/db";
import { entries as entriesTable, items as itemsTable, gstPurchaseHistory, accounts, entryGroups } from "@/db/schema";
import { inArray, eq, desc, count, and, not, isNotNull, sql } from "drizzle-orm";
import { getAggregateBalances, getBatchAggregateBalances } from "@/lib/balance";
import type { z } from "zod";
import type {
  ListTxSchema,
  GetByIdSchema,
  CreatePurchaseSchema,
  UpdatePurchaseSchema,
  DeleteTxSchema,
} from "./schema";

export async function listPurchases(input: z.infer<typeof ListTxSchema>) {
  const result = await listTransactions("PURCHASE", input);
  
  if (result.data.length === 0) return result;
  
  const groupIds = result.data.map(d => d.group.id);
  const txEntries = await db
    .select({
      entry: entriesTable,
      item_name: itemsTable.name,
      item_type: itemsTable.type,
    })
    .from(entriesTable)
    .leftJoin(itemsTable, eq(entriesTable.item_id, itemsTable.id))
    .where(inArray(entriesTable.group_id, groupIds));

  // Check which purchases have been converted to GST
  const convertedGroups = await db
    .select({ purchase_id: gstPurchaseHistory.purchase_id, created_at: gstPurchaseHistory.created_at })
    .from(gstPurchaseHistory)
    .where(inArray(gstPurchaseHistory.purchase_id, groupIds));

  // Find the single overall latest GST purchase conversion
  const [latestGstPurchase] = await db
    .select({
      purchase_id: gstPurchaseHistory.purchase_id,
      created_at: gstPurchaseHistory.created_at,
    })
    .from(gstPurchaseHistory)
    .orderBy(desc(gstPurchaseHistory.created_at))
    .limit(1);

  const convertedMap = new Map(convertedGroups.map((c) => [c.purchase_id, c.created_at]));

  const enrichedData = result.data.map((d) => {
    const groupEntries = txEntries.filter(e => e.entry.group_id === d.group.id);
    const isConverted = convertedMap.has(d.group.id);
    const isLatest = latestGstPurchase && d.group.id === latestGstPurchase.purchase_id;
    const convertedAt = convertedMap.get(d.group.id);
    const isWithinTime = isLatest && convertedAt && (Date.now() - new Date(convertedAt).getTime()) <= 12 * 60 * 60 * 1000;

    return {
      ...d,
      entries: groupEntries,
      isConverted,
      canUndoConversion: !!(isLatest && isWithinTime),
      convertedAt: convertedAt ? convertedAt.toISOString() : null,
    };
  });

  // Batch-fetch opening balances in a single query
  const tuples = enrichedData.map((d) => ({
    id: d.group.id,
    accountId: d.group.account_id,
    createdAt: new Date(d.group.created_at),
    excludeGroupId: d.group.id,
  }));
  const batchBalances = await getBatchAggregateBalances(tuples);

  const finalEnrichedData = enrichedData.map((d) => {
    const opening = batchBalances[d.group.id]!;

    // openingPure: prior net pure grams owed (negated — positive = shop owes supplier)
    // openingCash: exact rupee balance owed to supplier
    //   = goldCashOut (Σ pure × rate per bill) − totalCash (payments already received)
    //   This correctly reflects each bill's own rate without any re-multiplication.
    const openingPureNum = -parseFloat(opening.balancePure.toString() || "0");
    const openingCashNum = parseFloat(opening.goldCashOut.toString() || "0")
      - parseFloat(opening.totalCash.toString() || "0");

    return {
      ...d,
      openingPure: openingPureNum.toFixed(4),
      openingCash: openingCashNum.toFixed(2),
      isConverted: d.isConverted,
      canUndoConversion: d.canUndoConversion,
      convertedAt: d.convertedAt,
    };
  });

  return { ...result, data: finalEnrichedData };
}

export async function getPurchaseById(input: z.infer<typeof GetByIdSchema>) {
  const tx = await getTransactionById(input.id);
  if (!tx) throw new AppError("NOT_FOUND", "Purchase not found");

  const billNo = tx.group.bill_no;
  let matchingSaleGroup: any[] = [];
  if (billNo !== null) {
    matchingSaleGroup = await db
      .select()
      .from(entryGroups)
      .where(
        and(
          eq(entryGroups.account_id, tx.group.account_id),
          eq(entryGroups.bill_no, billNo),
          eq(entryGroups.type, "SALE"),
          eq(entryGroups.is_deleted, false)
        )
      )
      .limit(1);
  }

  const saleGroup = matchingSaleGroup[0];
  let saleEntries: any[] = [];
  if (saleGroup) {
    saleEntries = await db
      .select({
        entry: entriesTable,
        item_name: itemsTable.name,
        item_type: itemsTable.type,
      })
      .from(entriesTable)
      .leftJoin(itemsTable, eq(entriesTable.item_id, itemsTable.id))
      .where(eq(entriesTable.group_id, saleGroup.id));
  }

  // Fetch opening balance at the time of the transaction (excluding the transaction itself)
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

  // Separate entries by item type
  const goldEntries = tx.entries.filter((e) => e.item_type === "GOLD");
  const ornamentEntries = tx.entries.filter((e) => e.item_type === "ORNAMENT");
  const moneyEntries = tx.entries.filter((e) => e.item_type === "MONEY");

  return {
    ...tx,
    goldEntries,
    ornamentEntries,
    moneyEntries,
    openingPure: opening.balancePure.toString(),
    openingCash: opening.totalCash.toString(),
    lastRate: lastGroup?.rate_per_gram || "0",
    matchingSale: saleGroup ? {
      group: saleGroup,
      entries: saleEntries
    } : null
  };
}

export async function createPurchase(
  input: z.infer<typeof CreatePurchaseSchema>,
  options?: { existingBillNo?: number; existingEntryNo?: number }
) {
  const allItems = [...input.gold_items, ...input.ornament_items];
  if (allItems.length === 0) {
    throw new AppError("VALIDATION_ERROR", "At least one item is required");
  }

  // Purchase bills support running balances — no settle-to-zero enforcement.
  // The purchaser's outstanding balance carries forward just like a sales bill.
  const rateNum = toDecimal(input.rate_per_gram || '0');
  const discountCash = toDecimal(input.discount || '0');
  const discountPureGrams = toDecimal(input.discount_pure || '0');
  const discountPureAsCash = rateNum.gt(0) ? discountPureGrams.times(rateNum) : toDecimal('0');
  const totalDiscountCash = discountCash.plus(discountPureAsCash);

  // Build entries: supplier → SHOP for goods; SHOP → supplier for cash payment & discount
  const entryInputs = [
    ...input.gold_items.map((item) => ({
      fromAccountId: input.account_id,
      toAccountId: SYSTEM_ACCOUNTS.SHOP_ID,
      itemId: item.item_id,
      quantity: item.quantity,
      purity: item.purity,
      // Use item-specific rate; fall back to group rate only if none provided
      rate: item.rate ?? input.rate_per_gram,
    })),
    ...input.ornament_items.map((item) => ({
      fromAccountId: input.account_id,
      toAccountId: SYSTEM_ACCOUNTS.SHOP_ID,
      itemId: item.item_id,
      quantity: item.quantity,
      purity: item.purity,
      // Use item-specific rate; fall back to group rate only if none provided
      rate: item.rate ?? input.rate_per_gram,
    })),
    // Money paid to supplier (shop pays out cash)
    ...(toDecimal(input.bank_amount).gt(0)
      ? [
          {
            fromAccountId: SYSTEM_ACCOUNTS.SHOP_ID,
            toAccountId: input.account_id,
            itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID,
            quantity: input.bank_amount,
            remarks: input.bank_details,
          },
        ]
      : []),
    // Discount — shop deducts from what it owes the supplier.
    // SHOP → SUPPLIER: reduces shop's outstanding payable to supplier.
    ...(totalDiscountCash.gt(0)
      ? [
          {
            fromAccountId: SYSTEM_ACCOUNTS.SHOP_ID,
            toAccountId: input.account_id,
            itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID,
            quantity: totalDiscountCash.toFixed(2),
            remarks: 'Discount',
          },
        ]
      : []),
  ];

  const { group, entries } = await createEntryGroup({
    type: "PURCHASE",
    accountId: input.account_id,
    date: input.date,
    billNo: options?.existingBillNo,
    entryNo: options?.existingEntryNo,
    ratePerGram: input.rate_per_gram,
    remarks: input.remarks,
    entries: entryInputs,
  });

  return { group, entries };
}

export async function updatePurchase(input: z.infer<typeof UpdatePurchaseSchema>) {
  // Fetch original group to retrieve bill_no and entry_no
  const [originalGroup] = await db
    .select({
      bill_no: entryGroups.bill_no,
      entry_no: entryGroups.entry_no,
    })
    .from(entryGroups)
    .where(eq(entryGroups.id, input.id))
    .limit(1);

  if (!originalGroup) {
    throw new AppError("NOT_FOUND", "Purchase not found");
  }

  // Reverse the original, then create a new one
  await reverseEntryGroup(input.id);
  const { id: _removed, ...createInput } = input;
  return createPurchase(createInput, {
    existingBillNo: originalGroup.bill_no ?? undefined,
    existingEntryNo: originalGroup.entry_no ?? undefined,
  });
}

export async function deletePurchase(input: z.infer<typeof DeleteTxSchema>) {
  throw new AppError("BUSINESS_RULE_VIOLATION", "Delete option has been disabled for purchases");
}

export async function updateGSTPurchaseConversion(
  input: { id: string; gst_amount: string; tds_amount: string; tcs_amount: string }
) {
  return db.transaction(async (tx) => {
    // 1. Fetch original group
    const [originalGroup] = await tx
      .select()
      .from(entryGroups)
      .where(eq(entryGroups.id, input.id))
      .limit(1);

    if (!originalGroup) throw new AppError("NOT_FOUND", "Purchase not found");

    // 2. Fetch original entries (and item details)
    const originalEntries = await tx
      .select({
        entry: entriesTable,
        item_name: itemsTable.name,
        item_type: itemsTable.type,
      })
      .from(entriesTable)
      .leftJoin(itemsTable, eq(entriesTable.item_id, itemsTable.id))
      .where(eq(entriesTable.group_id, input.id));

    // Calculate display fields for flat table copy
    const itemEntries = originalEntries.filter((e) => e.item_type === "GOLD" || e.item_type === "ORNAMENT");
    const moneyEntries = originalEntries.filter((e) => e.item_type === "MONEY");

    const itemNames = Array.from(
      new Set(itemEntries.map((e) => e.item_name).filter(Boolean))
    ).join(", ");

    const itemTypeLabel = (() => {
      const types = new Set(itemEntries.map((e) => e.item_type));
      if (types.size === 0) return "-";
      if (types.size > 1) return "Mixed";
      return types.has("GOLD") ? "Gold" : "Ornament";
    })();

    const rate = parseFloat(originalGroup.rate_per_gram || "0");
    const currentPure = itemEntries.reduce(
      (s: number, e: any) => s + parseFloat(e.entry.pure_quantity || "0"),
      0,
    );
    const currentCash = currentPure * rate;
    const bankPaidAmount = moneyEntries.reduce(
      (s: number, e: any) => s + parseFloat(e.entry.quantity || "0"),
      0,
    );

    // Fetch opening balance up to this group (exclusive of this group)
    const opening = await getAggregateBalances(
      originalGroup.account_id,
      new Date(originalGroup.created_at),
      originalGroup.id
    );
    const priorBalancePure = -parseFloat(opening.balancePure.toString() || "0");
    // openingCash = goldCashOut - payments received = exact rupee balance owed to supplier
    const priorBalanceCash = parseFloat(opening.goldCashOut.toString() || "0")
      - parseFloat(opening.totalCash.toString() || "0");

    // Match Sales formula: totalCashPaid = -openingCash + payment
    const totalCashPaid = -priorBalanceCash + bankPaidAmount;
    const balancePure = priorBalancePure + currentPure - (rate > 0 ? totalCashPaid / rate : 0);
    const balanceCash = balancePure * rate;

    // 3. Create the flat copy in the gst_purchase_history table
    const [inserted] = await tx
      .insert(gstPurchaseHistory)
      .values({
        purchase_id: originalGroup.id,
        entry_no: originalGroup.entry_no?.toString() || "-",
        bill_no: originalGroup.bill_no?.toString() || "-",
        date: originalGroup.date ? new Date(originalGroup.date) : new Date(),
        account_id: originalGroup.account_id,
        pure: currentPure.toString(),
        cash: currentCash.toString(),
        gst_amount: input.gst_amount,
        tds_amount: input.tds_amount,
        tcs_amount: input.tcs_amount,
        type: "PURCHASE",
        rate: rate.toString(),
        item_type: itemNames ? `${itemTypeLabel} (${itemNames})` : itemTypeLabel,
        bal_pure: balancePure.toString(),
        bal_cash: balanceCash.toString(),
        bank_paid: bankPaidAmount.toString(),
        bank_receive: "0",
        cash_paid: "0",
      })
      .returning();

    if (!inserted) throw new AppError("INTERNAL_ERROR", "Failed to create GST Purchase copy");

    return inserted;
  });
}

export async function listGSTPurchaseHistory(input: z.infer<typeof ListTxSchema>) {
  const offset = (input.page - 1) * input.limit;

  const [data, [countRow]] = await Promise.all([
    db
      .select({
        id: gstPurchaseHistory.id,
        purchase_id: gstPurchaseHistory.purchase_id,
        entryNo: gstPurchaseHistory.entry_no,
        billNo: gstPurchaseHistory.bill_no,
        date: gstPurchaseHistory.date,
        account_id: gstPurchaseHistory.account_id,
        pure: gstPurchaseHistory.pure,
        cash: gstPurchaseHistory.cash,
        gstAmount: gstPurchaseHistory.gst_amount,
        tdsAmount: gstPurchaseHistory.tds_amount,
        tcsAmount: gstPurchaseHistory.tcs_amount,
        type: gstPurchaseHistory.type,
        rate: gstPurchaseHistory.rate,
        itemType: gstPurchaseHistory.item_type,
        balPure: gstPurchaseHistory.bal_pure,
        balCash: gstPurchaseHistory.bal_cash,
        bankPaid: gstPurchaseHistory.bank_paid,
        bankReceive: gstPurchaseHistory.bank_receive,
        cashPaid: gstPurchaseHistory.cash_paid,
        account_name: accounts.name,
      })
      .from(gstPurchaseHistory)
      .leftJoin(accounts, eq(gstPurchaseHistory.account_id, accounts.id))
      .orderBy(desc(gstPurchaseHistory.created_at))
      .limit(input.limit)
      .offset(offset),
    db.select({ total: count() }).from(gstPurchaseHistory),
  ]);

  const mappedData = data.map((row) => ({
    id: row.id,
    purchaseId: row.purchase_id,
    accountId: row.account_id,
    entryNo: row.entryNo,
    date: row.date ? new Date(row.date).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "-",
    billNo: row.billNo,
    name: row.account_name || "-",
    pure: parseFloat(row.pure) > 0 ? parseFloat(row.pure).toFixed(3) : "-",
    cash: parseFloat(row.cash) > 0 ? parseFloat(row.cash).toFixed(2) : "-",
    type: row.type,
    rate: parseFloat(row.rate) > 0 ? parseFloat(row.rate).toFixed(2) : "-",
    itemType: row.itemType,
    balPure: parseFloat(row.balPure).toFixed(3),
    balCash: parseFloat(row.balCash).toFixed(2),
    bankPaid: parseFloat(row.bankPaid || "0") > 0 ? parseFloat(row.bankPaid || "0").toFixed(2) : "-",
    bankReceive: parseFloat(row.bankReceive || "0") > 0 ? parseFloat(row.bankReceive || "0").toFixed(2) : "-",
    cashPaid: parseFloat(row.cashPaid || "0") > 0 ? parseFloat(row.cashPaid || "0").toFixed(2) : "-",
    gstAmount: parseFloat(row.gstAmount) > 0 ? parseFloat(row.gstAmount).toFixed(2) : "-",
    tdsAmount: parseFloat(row.tdsAmount || "0") > 0 ? parseFloat(row.tdsAmount || "0").toFixed(2) : "-",
    tcsAmount: parseFloat(row.tcsAmount || "0") > 0 ? parseFloat(row.tcsAmount || "0").toFixed(2) : "-",
  }));

  return { data: mappedData, total: countRow?.total ?? 0 };
}

export async function undoGSTPurchaseConversion(purchaseId: string) {
  return db.transaction(async (tx) => {
    // 1. Fetch the corresponding row in gstPurchaseHistory
    const [gstRow] = await tx
      .select()
      .from(gstPurchaseHistory)
      .where(eq(gstPurchaseHistory.purchase_id, purchaseId))
      .limit(1);

    if (!gstRow) throw new AppError("NOT_FOUND", "GST conversion record not found");

    // 2. Enforce the sequence/timing check
    const [latestGstPurchase] = await tx
      .select({ id: gstPurchaseHistory.id, created_at: gstPurchaseHistory.created_at })
      .from(gstPurchaseHistory)
      .orderBy(desc(gstPurchaseHistory.created_at))
      .limit(1);

    if (!latestGstPurchase || latestGstPurchase.id !== gstRow.id) {
      throw new AppError("BUSINESS_RULE_VIOLATION", "Only the most recent GST conversion can be undone");
    }

    // Check if 12 hours have passed
    const elapsedMs = Date.now() - new Date(gstRow.created_at).getTime();
    if (elapsedMs > 12 * 60 * 60 * 1000) {
      throw new AppError("BUSINESS_RULE_VIOLATION", "GST conversion can only be undone within 12 hours");
    }

    // 3. Delete the GST conversion copy
    await tx.delete(gstPurchaseHistory).where(eq(gstPurchaseHistory.id, gstRow.id));

    return { success: true };
  });
}

