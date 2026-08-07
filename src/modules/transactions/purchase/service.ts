import { AppError } from "@/types/errors";
import { createEntryGroup } from "@/lib/entryBuilder";
import { reverseEntryGroup } from "@/lib/reversal";
import { toQuantityString, toDecimal, Decimal } from "@/lib/decimal";
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
  ConvertGoldToCashSchema,
  ConvertCashToGoldSchema,
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
    const openingPureNum = -parseFloat(opening.balancePure.toString() || "0");

    // openingCash: prior net cash owed (negated — positive = shop owes supplier)
    const openingCashNum = -parseFloat(opening.totalCash.toString() || "0");

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

  // A discount is written by createPurchase as a MONEY entry with remarks 'Discount',
  // structurally identical to a bank payment (both SHOP → supplier). Split them so the
  // edit form can rehydrate each field independently — without this the form cannot see
  // the discount, sends back "0", and the reverse-and-recreate update silently erases it.
  const discountEntries = moneyEntries.filter((e) => e.entry.remarks === "Discount");
  const paymentEntries = moneyEntries.filter((e) => e.entry.remarks !== "Discount" && e.entry.remarks !== "Cash Purchase Charge");

  // Opening Cash & Pure: negated for supplier (positive = shop owes supplier)
  const openingPureBalance = opening.balancePure.negated();
  const openingCashBalance = opening.totalCash.negated();

  return {
    ...tx,
    goldEntries,
    ornamentEntries,
    moneyEntries,
    paymentEntries,
    discountEntries,
    openingPure: openingPureBalance.toString(),
    openingCash: openingCashBalance.toFixed(2),
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

  const isCashMode = input.balance_mode === "CASH";

  // Calculate total cash value and total pure weight for items
  let totalPurchaseCashVal = toDecimal(0);
  let totalPureQty = toDecimal(0);
  allItems.forEach((item) => {
    const qty = toDecimal(item.quantity);
    const pur = toDecimal(item.purity);
    const pure = qty.times(pur).div(100);
    const r = toDecimal(item.rate ?? input.rate_per_gram ?? '0');
    totalPurchaseCashVal = totalPurchaseCashVal.plus(pure.times(r));
    totalPureQty = totalPureQty.plus(pure);
  });

  // ─── Overpayment guard ─────────────────────────────────────────────────────
  // The bank payment on this bill must never push the supplier's balance below
  // zero — i.e. bank_amount can't exceed (opening balance + this bill's value −
  // discounts). Mirrors the client-side guard in PurchasePage.tsx, but this is
  // the authoritative check since tRPC can be called directly, bypassing the UI.
  // On an edit, updatePurchase() reverses the original bill first, so the
  // balance read here is already "as if this bill didn't exist yet".
  const bankAmt = toDecimal(input.bank_amount || "0");
  if (bankAmt.gt(0)) {
    const opening = await getAggregateBalances(input.account_id);
    const openingCash = opening.totalCash.negated(); // positive = shop owes supplier
    const openingPure = opening.balancePure.negated();

    let maxBankPayment: Decimal;
    if (isCashMode) {
      maxBankPayment = openingCash.plus(totalPurchaseCashVal).minus(totalDiscountCash);
    } else {
      const effectiveRate = totalPureQty.gt(0) && totalPurchaseCashVal.gt(0)
        ? totalPurchaseCashVal.div(totalPureQty)
        : rateNum;
      const discountCashAsPure = effectiveRate.gt(0) ? discountCash.div(effectiveRate) : toDecimal(0);
      const maxBalancePure = openingPure.plus(totalPureQty).minus(discountPureGrams).minus(discountCashAsPure);
      maxBankPayment = maxBalancePure.times(effectiveRate);
    }

    if (bankAmt.gt(maxBankPayment.plus(0.01))) {
      const cappedMax = maxBankPayment.lt(0) ? toDecimal(0) : maxBankPayment;
      throw new AppError(
        "VALIDATION_ERROR",
        `Payment ₹${bankAmt.toFixed(2)} exceeds the outstanding balance of ₹${cappedMax.toFixed(2)}. Payment cannot exceed total owed.`,
      );
    }
  }

  // Build entries: supplier → SHOP for goods; SHOP → supplier for cash payment & discount
  const entryInputs = [
    ...input.gold_items.map((item) => ({
      fromAccountId: input.account_id,
      toAccountId: SYSTEM_ACCOUNTS.SHOP_ID,
      itemId: item.item_id,
      quantity: item.quantity,
      purity: item.purity,
      rate: item.rate ?? input.rate_per_gram,
      pureQuantity: isCashMode ? "0" : undefined,
    })),
    ...input.ornament_items.map((item) => ({
      fromAccountId: input.account_id,
      toAccountId: SYSTEM_ACCOUNTS.SHOP_ID,
      itemId: item.item_id,
      quantity: item.quantity,
      purity: item.purity,
      rate: item.rate ?? input.rate_per_gram,
      pureQuantity: isCashMode ? "0" : undefined,
    })),
    // In CASH mode: record the cash value of the purchase as a cash charge from the supplier to shop.
    // Direction: supplier → SHOP (same as gold entries), so Supplier ledger registers cash outflow.
    ...(isCashMode && totalPurchaseCashVal.gt(0)
      ? [
          {
            fromAccountId: input.account_id,
            toAccountId: SYSTEM_ACCOUNTS.SHOP_ID,
            itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID,
            quantity: totalPurchaseCashVal.toFixed(2),
            remarks: "Cash Purchase Charge",
          },
        ]
      : []),
    // Money paid to supplier (shop pays out cash: SHOP → supplier)
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
    // Discount — shop deducts from what it owes the supplier (SHOP → supplier)
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

/**
 * Converts part of a purchaser's outstanding pure-gold balance into a cash debt.
 *
 * Pure ledger reclassification — the gold never physically moves (it's already in
 * shop stock from the original purchase), so both entries use RUPEE_ITEM_ID and
 * SHOP_ID as the counterparty. Using RUPEE_ITEM_ID (not a real gold item) means
 * neither entry is ever picked up by item-level stock queries, which only look at
 * specific GOLD/ORNAMENT item ids — so stock-on-hand is untouched, exactly like the
 * existing "opening pure balance" entries created in accounts/service.ts.
 *
 * Entry 1 reduces gold owed: SHOP → supplier, pureQuantity override = gold_grams,
 * quantity "0" (no cash effect). Entry 2 raises cash owed: supplier → SHOP,
 * quantity = cash_amount (mirrors the "Cash Purchase Charge" direction).
 */
export async function convertGoldToCash(input: z.infer<typeof ConvertGoldToCashSchema>) {
  const goldGrams = toDecimal(input.gold_grams);
  // Derived, not trusted from the client — see schema.ts for why.
  const cashAmount = goldGrams.times(toDecimal(input.rate_per_gram));

  const opening = await getAggregateBalances(input.account_id);
  const openingPure = opening.balancePure.negated(); // positive = shop owes supplier

  if (openingPure.lte(0)) {
    throw new AppError("BUSINESS_RULE_VIOLATION", "This account has no outstanding gold balance to convert.");
  }
  if (goldGrams.gt(openingPure.plus(0.001))) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Cannot convert ${goldGrams.toFixed(3)}g — only ${openingPure.toFixed(3)}g of gold is outstanding for this account.`,
    );
  }

  const today = new Date().toISOString().split("T")[0]!;
  const label = `Gold to Cash Conversion (${goldGrams.toFixed(3)}g @ ₹${toDecimal(input.rate_per_gram).toFixed(2)}/g)`;

  const { group, entries } = await createEntryGroup({
    type: "PURCHASE",
    accountId: input.account_id,
    date: today,
    ratePerGram: input.rate_per_gram,
    remarks: label,
    entries: [
      {
        // Reduces gold owed to the supplier
        fromAccountId: SYSTEM_ACCOUNTS.SHOP_ID,
        toAccountId: input.account_id,
        itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID,
        quantity: "0",
        pureQuantity: goldGrams.toFixed(3),
        remarks: label,
      },
      {
        // Raises cash owed to the supplier
        fromAccountId: input.account_id,
        toAccountId: SYSTEM_ACCOUNTS.SHOP_ID,
        itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID,
        quantity: cashAmount.toFixed(2),
        remarks: label,
      },
    ],
  });

  return { group, entries };
}

/**
 * The opposite of convertGoldToCash: converts part of a purchaser's outstanding
 * cash debt into a pure-gold debt, at an agreed rate. Same RUPEE_ITEM_ID +
 * SHOP_ID trick, entries simply reversed — stock-on-hand stays untouched.
 *
 * Entry 1 reduces cash owed: SHOP → supplier, quantity = cash_amount (mirrors
 * a normal bank payment). Entry 2 raises gold owed: supplier → SHOP,
 * pureQuantity override = gold_grams, quantity "0" (no cash effect).
 */
export async function convertCashToGold(input: z.infer<typeof ConvertCashToGoldSchema>) {
  const cashAmount = toDecimal(input.cash_amount);
  const rate = toDecimal(input.rate_per_gram);
  // Derived, not trusted from the client — see schema.ts for why.
  const goldGrams = cashAmount.div(rate);

  const opening = await getAggregateBalances(input.account_id);
  const openingCash = opening.totalCash.negated(); // positive = shop owes supplier

  if (openingCash.lte(0)) {
    throw new AppError("BUSINESS_RULE_VIOLATION", "This account has no outstanding cash balance to convert.");
  }
  if (cashAmount.gt(openingCash.plus(0.01))) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Cannot convert ₹${cashAmount.toFixed(2)} — only ₹${openingCash.toFixed(2)} of cash is outstanding for this account.`,
    );
  }

  const today = new Date().toISOString().split("T")[0]!;
  const label = `Cash to Gold Conversion (${goldGrams.toFixed(3)}g @ ₹${toDecimal(input.rate_per_gram).toFixed(2)}/g)`;

  const { group, entries } = await createEntryGroup({
    type: "PURCHASE",
    accountId: input.account_id,
    date: today,
    ratePerGram: input.rate_per_gram,
    remarks: label,
    entries: [
      {
        // Reduces cash owed to the supplier
        fromAccountId: SYSTEM_ACCOUNTS.SHOP_ID,
        toAccountId: input.account_id,
        itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID,
        quantity: cashAmount.toFixed(2),
        remarks: label,
      },
      {
        // Raises gold owed to the supplier
        fromAccountId: input.account_id,
        toAccountId: SYSTEM_ACCOUNTS.SHOP_ID,
        itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID,
        quantity: "0",
        pureQuantity: goldGrams.toFixed(3),
        remarks: label,
      },
    ],
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
    // openingCash = (goldCashOut − goldCashIn) − payments received = rupee balance owed
    // to supplier. Netting goldCashIn keeps this correct after a bill is edited/reversed.
    const priorBalanceCash = parseFloat(opening.goldCashOut.toString() || "0")
      - parseFloat(opening.goldCashIn.toString() || "0")
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

// ─── Remarks-based cash balance for purchases ─────────────────────────────────
// openingCash = Σ(Cash Purchase Charge) − Σ(bank payments) − Σ(discounts)
// Works regardless of entry direction (old SHOP→supplier vs new supplier→SHOP)
// because we categorize by `remarks` field, not by from/to direction.

const CASH_PURCHASE_CHARGE_REMARK = "Cash Purchase Charge";
const DISCOUNT_REMARK = "Discount";

async function getPurchaseCashBalance(
  accountId: string,
  asOfDate: Date,
  excludeGroupId: string,
): Promise<string> {
  const cashItemId = SYSTEM_ITEMS.RUPEE_ITEM_ID;

  const [row] = await db.execute<{
    cash_charges: string | null;
    bank_payments: string | null;
    discounts: string | null;
  }>(sql`
    SELECT
      COALESCE(SUM(CASE WHEN e.remarks = ${CASH_PURCHASE_CHARGE_REMARK} THEN e.quantity ELSE 0 END), 0)::text AS cash_charges,
      COALESCE(SUM(CASE WHEN e.remarks != ${CASH_PURCHASE_CHARGE_REMARK} AND e.remarks != ${DISCOUNT_REMARK} THEN e.quantity ELSE 0 END), 0)::text AS bank_payments,
      COALESCE(SUM(CASE WHEN e.remarks = ${DISCOUNT_REMARK} THEN e.quantity ELSE 0 END), 0)::text AS discounts
    FROM entries e
    LEFT JOIN entry_groups g ON e.group_id = g.id
    WHERE e.item_id = ${cashItemId}
      AND (e.to_account_id = ${accountId} OR e.from_account_id = ${accountId})
      AND e.created_at <= ${asOfDate.toISOString()}
      AND e.group_id != ${excludeGroupId}
      AND g.type = 'PURCHASE'
      AND g.is_deleted = false
  `);

  const charges = parseFloat(row?.cash_charges ?? "0");
  const payments = parseFloat(row?.bank_payments ?? "0");
  const discounts = parseFloat(row?.discounts ?? "0");
  return (charges - payments - discounts).toFixed(2);
}

async function getPurchaseBatchCashBalances(
  tuples: { id: string; accountId: string; createdAt: Date; excludeGroupId: string }[],
): Promise<Record<string, number>> {
  if (tuples.length === 0) return {};

  const cashItemId = SYSTEM_ITEMS.RUPEE_ITEM_ID;

  const valuesChunks = tuples.map(
    (t) => sql`(${t.id}::text, ${t.accountId}::uuid, ${t.createdAt.toISOString()}::timestamp, ${t.excludeGroupId}::uuid)`
  );

  const rows = await db.execute<{
    id: string;
    cash_charges: string | null;
    bank_payments: string | null;
    discounts: string | null;
  }>(sql`
    WITH params(id, account_id, created_at, exclude_group_id) AS (
      VALUES ${sql.join(valuesChunks, sql`, `)}
    )
    SELECT
      p.id,
      COALESCE(SUM(CASE WHEN e.remarks = ${CASH_PURCHASE_CHARGE_REMARK} THEN e.quantity ELSE 0 END), 0)::text AS cash_charges,
      COALESCE(SUM(CASE WHEN e.remarks != ${CASH_PURCHASE_CHARGE_REMARK} AND e.remarks != ${DISCOUNT_REMARK} THEN e.quantity ELSE 0 END), 0)::text AS bank_payments,
      COALESCE(SUM(CASE WHEN e.remarks = ${DISCOUNT_REMARK} THEN e.quantity ELSE 0 END), 0)::text AS discounts
    FROM params p
    LEFT JOIN entries e ON
      (e.to_account_id = p.account_id OR e.from_account_id = p.account_id)
      AND e.item_id = ${cashItemId}
      AND e.created_at <= p.created_at
      AND e.group_id != p.exclude_group_id
    LEFT JOIN entry_groups g ON e.group_id = g.id AND g.type = 'PURCHASE' AND g.is_deleted = false
    WHERE g.id IS NOT NULL OR e.id IS NULL
    GROUP BY p.id
  `);

  const results: Record<string, number> = {};
  for (const row of rows) {
    const charges = parseFloat(row.cash_charges ?? "0");
    const payments = parseFloat(row.bank_payments ?? "0");
    const discounts = parseFloat(row.discounts ?? "0");
    results[row.id] = charges - payments - discounts;
  }

  // Default any missing IDs to 0
  for (const t of tuples) {
    if (results[t.id] === undefined) results[t.id] = 0;
  }

  return results;
}
