import { AppError } from "@/types/errors";
import { createEntryGroup } from "@/lib/entryBuilder";
import { reverseEntryGroup } from "@/lib/reversal";
import { generateEntryGroupNo } from "@/lib/entryNoGenerator";
import {
  calcWastagePercent,
  calcWastageGram,
  toDecimal,
  toQuantityString,
} from "@/lib/decimal";
import { SYSTEM_ACCOUNTS, SYSTEM_ITEMS } from "@/config/constants";
import {
  listTransactions,
  getTransactionById,
  generateBillNo,
} from "@/lib/transactionQueries";
import { db } from "@/db";
import { entries, entries as entriesTable, items as itemsTable, accounts, entryGroups, gstSalesHistory } from "@/db/schema";
import { sql, inArray, eq, desc, count, not, isNotNull, and } from "drizzle-orm";
import { createSystemNotification } from "@/modules/notifications/service";
import { getAggregateBalances, getBatchAggregateBalances } from "@/lib/balance";
import type { z } from "zod";
import type {
  ListTxSchema,
  GetByIdSchema,
  CreateSalesSchema,
  UpdateSalesSchema,
  DeleteTxSchema,
} from "./schema";

export async function listSales(input: z.infer<typeof ListTxSchema>) {
  const result = await listTransactions("SALE", input);

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

  // Check which sales have been converted to GST
  const convertedGroups = await db
    .select({ sale_id: gstSalesHistory.sale_id, created_at: gstSalesHistory.created_at })
    .from(gstSalesHistory)
    .where(inArray(gstSalesHistory.sale_id, groupIds));

  // Find the single overall latest GST sale conversion
  const [latestGstSale] = await db
    .select({
      sale_id: gstSalesHistory.sale_id,
      created_at: gstSalesHistory.created_at,
    })
    .from(gstSalesHistory)
    .orderBy(desc(gstSalesHistory.created_at))
    .limit(1);

  const convertedMap = new Map(convertedGroups.map((c) => [c.sale_id, c.created_at]));

  const enrichedData = result.data.map((d) => {
    const isConverted = convertedMap.has(d.group.id);
    const isLatest = latestGstSale && d.group.id === latestGstSale.sale_id;
    const convertedAt = convertedMap.get(d.group.id);
    const isWithinTime = isLatest && convertedAt && (Date.now() - new Date(convertedAt).getTime()) <= 12 * 60 * 60 * 1000;

    return {
      ...d,
      entries: txEntries.filter((e) => e.entry.group_id === d.group.id),
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

    return {
      ...d,
      // openingPure = rate-stable balance before this bill (pure grams).
      // balancePure = totalPure − Σ(prior_payment / prior_rate) — never affected by rate changes.
      openingPure: opening.totalPure.toFixed(4),
      // openingCash is kept for backward compatibility display in the history table.
      // It is the raw totalCash ledger value (negative = prior payments sent by customer).
      openingCash: opening.totalCash.toFixed(2),
      isConverted: d.isConverted,
      canUndoConversion: d.canUndoConversion,
      convertedAt: d.convertedAt,
    };
  });

  return { data: finalEnrichedData, total: result.total };
}

export async function getSaleById(input: z.infer<typeof GetByIdSchema>) {
  const tx = await getTransactionById(input.id);
  if (!tx) throw new AppError("NOT_FOUND", "Sale not found");

  const billNo = tx.group.bill_no;
  let matchingPurchaseGroup: any[] = [];
  if (billNo !== null) {
    matchingPurchaseGroup = await db
      .select()
      .from(entryGroups)
      .where(
        and(
          eq(entryGroups.account_id, tx.group.account_id),
          eq(entryGroups.bill_no, billNo),
          eq(entryGroups.type, "PURCHASE"),
          eq(entryGroups.is_deleted, false)
        )
      )
      .limit(1);
  }

  const purchaseGroup = matchingPurchaseGroup[0];
  let purchaseEntries: any[] = [];
  if (purchaseGroup) {
    purchaseEntries = await db
      .select({
        entry: entriesTable,
        item_name: itemsTable.name,
        item_type: itemsTable.type,
      })
      .from(entriesTable)
      .leftJoin(itemsTable, eq(entriesTable.item_id, itemsTable.id))
      .where(eq(entriesTable.group_id, purchaseGroup.id));
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

  return {
    ...tx,
    openingPure: opening.balancePure.toString(),
    openingCash: opening.totalCash.toString(),
    lastRate: lastGroup?.rate_per_gram || "0",
    matchingPurchase: purchaseGroup ? {
      group: purchaseGroup,
      entries: purchaseEntries
    } : null
  };
}

export async function createSale(
  input: z.infer<typeof CreateSalesSchema>,
  creator: { id: string; username: string },
  isUpdate: boolean = false,
  options?: { existingBillNo?: number; existingEntryNo?: number; groupId?: string }
) {
  // Step 1 — Per-item wastage + pure calculations
  const processedItems = input.items.map((item) => {
    if (item.wastage_mode === "PERCENT" && toDecimal(item.purity).lte(0)) {
      throw new AppError(
        "BUSINESS_RULE_VIOLATION",
        "Purity must be greater than zero when using PERCENT wastage mode"
      );
    }
    const wastageQty =
      item.wastage_mode === "PERCENT"
        ? calcWastagePercent(item.quantity, item.wastage_value, item.purity)
        : calcWastageGram(item.quantity, item.wastage_value);

    const totalQuantity = toDecimal(item.quantity).plus(wastageQty);
    const totalQuantityStr = toQuantityString(totalQuantity);

    return { ...item, totalQuantityStr, wastageQty: toQuantityString(wastageQty) };
  });

  // Steps 5–7 inside one transaction so the SELECT FOR UPDATE lock is held
  // through the insert — prevents two concurrent sales from overselling the same lot.
  return db.transaction(async (tx) => {
    // Overpayment validation check
    const ratePerGram = toDecimal(input.rate_per_gram);
    const pureValuePure = processedItems.reduce((acc, item) => {
      return acc.plus(toDecimal(item.totalQuantityStr).mul(toDecimal(item.purity).div(100)));
    }, toDecimal(0));
    const pureValueCash = pureValuePure.mul(ratePerGram);

    const discountCash = toDecimal(input.discount ?? "0");
    const discountPure = toDecimal(input.discount_pure ?? "0");
    const discountPureAsCash = discountPure.mul(ratePerGram);
    const tdsAmount = toDecimal(input.tds_amount ?? "0");
    const tcsAmount = toDecimal(input.tcs_amount ?? "0");
    const bankAmount = toDecimal(input.bank_amount ?? "0");

    const opening = await getAggregateBalances(input.account_id, undefined, options?.groupId);
    const parsedOpeningPure = opening.balancePure;

    const [lastGroup] = await tx
      .select({ rate_per_gram: entryGroups.rate_per_gram })
      .from(entryGroups)
      .where(
        and(
          eq(entryGroups.account_id, input.account_id),
          eq(entryGroups.is_deleted, false),
          not(eq(entryGroups.type, "REVERSAL")),
          isNotNull(entryGroups.rate_per_gram),
          options?.groupId ? not(eq(entryGroups.id, options.groupId)) : undefined
        )
      )
      .orderBy(desc(entryGroups.created_at))
      .limit(1);

    const lastRate = toDecimal(lastGroup?.rate_per_gram ?? "0");
    const parsedOpeningCash = lastRate.gt(0) ? parsedOpeningPure.mul(lastRate) : toDecimal(0);

    if (input.balance_mode === "PURE") {
      const bankInPure = ratePerGram.gt(0) ? bankAmount.div(ratePerGram) : toDecimal(0);
      const discountCashAsPure = ratePerGram.gt(0) ? discountCash.div(ratePerGram) : toDecimal(0);
      const tdsInPure = ratePerGram.gt(0) ? tdsAmount.div(ratePerGram) : toDecimal(0);
      const tcsInPure = ratePerGram.gt(0) ? tcsAmount.div(ratePerGram) : toDecimal(0);

      const totalOwedPure = parsedOpeningPure
        .plus(pureValuePure)
        .minus(discountPure)
        .minus(discountCashAsPure)
        .minus(tdsInPure)
        .plus(tcsInPure);

      const maxAllowedCash = totalOwedPure.mul(ratePerGram);
      if (bankAmount.gt(maxAllowedCash.plus(0.01))) {
        throw new AppError(
          "BUSINESS_RULE_VIOLATION",
          `Payment amount ₹${bankAmount.toFixed(2)} exceeds the outstanding balance ₹${Math.max(0, parseFloat(maxAllowedCash.toFixed(2)))}`
        );
      }
    } else {
      const totalOwedCash = parsedOpeningCash
        .plus(pureValueCash)
        .minus(discountCash)
        .minus(discountPureAsCash)
        .minus(tdsAmount)
        .plus(tcsAmount);

      if (bankAmount.gt(totalOwedCash.plus(0.01))) {
        throw new AppError(
          "BUSINESS_RULE_VIOLATION",
          `Payment amount ₹${bankAmount.toFixed(2)} exceeds the outstanding balance ₹${Math.max(0, parseFloat(totalOwedCash.toFixed(2)))}`
        );
      }
    }
    // Step 5 — Lock entry rows then read lot balance within the same transaction in parallel
    await Promise.all(
      processedItems.map(async (item) => {
        await tx.execute(
          sql`SELECT id FROM ${entries}
              WHERE item_id = ${item.item_id}
                AND lot_id IS NOT NULL
                AND (to_account_id = ${SYSTEM_ACCOUNTS.SHOP_ID} OR from_account_id = ${SYSTEM_ACCOUNTS.SHOP_ID})
              FOR UPDATE`,
        );
        const [row] = await tx.execute<{ available: string }>(
          sql`SELECT COALESCE(SUM(CASE WHEN to_account_id = ${SYSTEM_ACCOUNTS.SHOP_ID} THEN quantity ELSE -quantity END), 0)::text AS available
              FROM ${entries}
              WHERE item_id = ${item.item_id}
                AND lot_id = ${item.lot_id}
                AND (to_account_id = ${SYSTEM_ACCOUNTS.SHOP_ID} OR from_account_id = ${SYSTEM_ACCOUNTS.SHOP_ID})`,
        );
        const available = toDecimal(row?.available ?? "0");
        if (available.lt(toDecimal(item.totalQuantityStr))) {
          throw new AppError(
            "BUSINESS_RULE_VIOLATION",
            `Insufficient stock for item ${item.item_id} in lot ${item.lot_id}`,
          );
        }
      })
    );

    // Step 6 — Bill number per customer (uses tx so it's consistent with the insert)
    const bill_no = options?.existingBillNo ?? await generateBillNo(tx, input.account_id, "SALE");

    // Step 7 — Build entries and write to ledger (lock still held)
    // ── Discount calculation ────────────────────────────────────────────────
    // Discounts reduce the customer's payable balance. We write a RUPEE entry
    // FROM the shop TO the customer (the shop "gives back" money) so that
    // getAggregateBalances subtracts it correctly via the payment-pure formula.
    const rateNum = ratePerGram;
    // discount_pure is in grams; convert to cash at bill rate for ledger entry.
    const discountPureGrams = toDecimal(input.discount_pure ?? "0");
    const totalDiscountCash = discountCash.plus(discountPureAsCash);

    const entryInputs = [
      ...processedItems.map((item) => ({
        fromAccountId: SYSTEM_ACCOUNTS.SHOP_ID,
        toAccountId: input.account_id,
        itemId: item.item_id,
        lotId: item.lot_id,
        quantity: item.totalQuantityStr, // quantity + wastage
        purity: item.purity,
        wastageMode: item.wastage_mode as "PERCENT" | "GRAM",
        wastageValue: item.wastage_value,
      })),
      // Cash received from customer
      ...(toDecimal(input.bank_amount).gt(0)
        ? [
            {
              fromAccountId: input.account_id,
              toAccountId: SYSTEM_ACCOUNTS.SHOP_ID,
              itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID,
              quantity: input.bank_amount,
              remarks: input.bank_details,
            },
          ]
        : []),
      // Discount — customer "pays" with the discount to reduce their payable balance.
      // Recorded as CUSTOMER → SHOP RUPEE flow so it behaves as a payment and reduces customer's gold balance.
      ...(totalDiscountCash.gt(0)
        ? [
            {
              fromAccountId: input.account_id,
              toAccountId: SYSTEM_ACCOUNTS.SHOP_ID,
              itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID,
              quantity: totalDiscountCash.toFixed(2),
              remarks: "Discount",
            },
          ]
        : []),
      // TDS — shop deducts TDS from the customer's payable (reduces customer's balance).
      // SHOP → CUSTOMER: reduces customer's net payable (equivalent to the shop absorbing TDS).
      ...(input.tds_enabled && toDecimal(input.tds_amount ?? "0").gt(0)
        ? [
            {
              fromAccountId: SYSTEM_ACCOUNTS.SHOP_ID,
              toAccountId: input.account_id,
              itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID,
              quantity: toDecimal(input.tds_amount!).toFixed(2),
              remarks: "TDS Adjustment",
            },
          ]
        : []),
      // TCS — customer pays extra TCS to the shop (increases customer's payable).
      // CUSTOMER → SHOP: increases customer's net payable.
      ...(input.tcs_enabled && toDecimal(input.tcs_amount ?? "0").gt(0)
        ? [
            {
              fromAccountId: input.account_id,
              toAccountId: SYSTEM_ACCOUNTS.SHOP_ID,
              itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID,
              quantity: toDecimal(input.tcs_amount!).toFixed(2),
              remarks: "TCS Adjustment",
            },
          ]
        : []),
    ];

    const result = await createEntryGroup(
      {
        type: "SALE",
        accountId: input.account_id,
        date: input.date,
        billNo: bill_no,
        entryNo: options?.existingEntryNo,
        ratePerGram: input.rate_per_gram,
        remarks: input.remarks,
        entries: entryInputs,
      },
      tx,
    );

    // Fetch customer name
    const [customer] = await tx
      .select({ name: accounts.name })
      .from(accounts)
      .where(eq(accounts.id, input.account_id))
      .limit(1);
    const customerName = customer?.name || "Unknown Customer";

    let message = "";
    if (isUpdate) {
      message = `Sale Bill #${bill_no} (updated) for Customer '${customerName}' was updated by ${creator.username}`;
    } else {
      message = `Sale Bill #${bill_no} for Customer '${customerName}' was created by ${creator.username}`;
    }

    await createSystemNotification(tx, message, creator.id);

    return result;
  });
}

export async function updateSale(
  input: z.infer<typeof UpdateSalesSchema>,
  creator: { id: string; username: string }
) {
  const [originalGroup] = await db
    .select({
      bill_no: entryGroups.bill_no,
      entry_no: entryGroups.entry_no,
    })
    .from(entryGroups)
    .where(eq(entryGroups.id, input.id))
    .limit(1);

  if (!originalGroup) {
    throw new AppError("NOT_FOUND", "Sale not found");
  }

  await reverseEntryGroup(input.id);
  const { id: _removed, ...createInput } = input;
  return createSale(createInput, creator, true, {
    existingBillNo: originalGroup.bill_no ?? undefined,
    existingEntryNo: originalGroup.entry_no ?? undefined,
    groupId: input.id,
  });
}

export async function deleteSale(
  input: z.infer<typeof DeleteTxSchema>,
  creator: { id: string; username: string }
) {
  throw new AppError("BUSINESS_RULE_VIOLATION", "Delete option has been disabled for sales");
}

export async function updateGSTConversion(
  input: { id: string; gst_amount: string; tds_amount: string; tcs_amount: string }
) {
  return db.transaction(async (tx) => {
    // 1. Fetch original group
    const [originalGroup] = await tx
      .select()
      .from(entryGroups)
      .where(eq(entryGroups.id, input.id))
      .limit(1);

    if (!originalGroup) throw new AppError("NOT_FOUND", "Sale not found");

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
    const openingPure = parseFloat(opening.balancePure.toString() || "0");

    // Rate-stable formula: opening balance + gold this bill − payment this bill / rate this bill.
    // openingPure is already Σ(pure_sold) − Σ(payment/rate) for all PRIOR bills.
    const billPaymentPure = rate > 0 ? bankPaidAmount / rate : 0;
    const balancePure = openingPure + currentPure - billPaymentPure;
    const balanceCash = balancePure * rate;

    // 3. Create the flat copy in the gst_sales_history table
    const [inserted] = await tx
      .insert(gstSalesHistory)
      .values({
        sale_id: originalGroup.id,
        entry_no: originalGroup.entry_no?.toString() || "-",
        bill_no: originalGroup.bill_no?.toString() || "-",
        date: originalGroup.date ? new Date(originalGroup.date) : new Date(),
        account_id: originalGroup.account_id,
        pure: currentPure.toString(),
        cash: currentCash.toString(),
        gst_amount: input.gst_amount,
        tds_amount: input.tds_amount,
        tcs_amount: input.tcs_amount,
        type: "SALE",
        rate: rate.toString(),
        item_type: itemNames ? `${itemTypeLabel} (${itemNames})` : itemTypeLabel,
        bal_pure: balancePure.toString(),
        bal_cash: balanceCash.toString(),
        bank_paid: "0",
        bank_receive: bankPaidAmount.toString(),
        cash_paid: "0",
      })
      .returning();

    if (!inserted) throw new AppError("INTERNAL_ERROR", "Failed to create GST copy");

    return inserted;
  });
}

export async function listGSTHistory(input: z.infer<typeof ListTxSchema>) {
  const offset = (input.page - 1) * input.limit;

  const [data, [countRow]] = await Promise.all([
    db
      .select({
        id: gstSalesHistory.id,
        sale_id: gstSalesHistory.sale_id,
        entryNo: gstSalesHistory.entry_no,
        billNo: gstSalesHistory.bill_no,
        date: gstSalesHistory.date,
        account_id: gstSalesHistory.account_id,
        pure: gstSalesHistory.pure,
        cash: gstSalesHistory.cash,
        gstAmount: gstSalesHistory.gst_amount,
        tdsAmount: gstSalesHistory.tds_amount,
        tcsAmount: gstSalesHistory.tcs_amount,
        type: gstSalesHistory.type,
        rate: gstSalesHistory.rate,
        itemType: gstSalesHistory.item_type,
        balPure: gstSalesHistory.bal_pure,
        balCash: gstSalesHistory.bal_cash,
        bankPaid: gstSalesHistory.bank_paid,
        bankReceive: gstSalesHistory.bank_receive,
        cashPaid: gstSalesHistory.cash_paid,
        account_name: accounts.name,
      })
      .from(gstSalesHistory)
      .leftJoin(accounts, eq(gstSalesHistory.account_id, accounts.id))
      .orderBy(desc(gstSalesHistory.created_at))
      .limit(input.limit)
      .offset(offset),
    db.select({ total: count() }).from(gstSalesHistory),
  ]);

  const mappedData = data.map((row) => ({
    id: row.id,
    saleId: row.sale_id,
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

export async function undoGSTConversion(saleId: string) {
  return db.transaction(async (tx) => {
    // 1. Fetch the corresponding row in gstSalesHistory
    const [gstRow] = await tx
      .select()
      .from(gstSalesHistory)
      .where(eq(gstSalesHistory.sale_id, saleId))
      .limit(1);

    if (!gstRow) throw new AppError("NOT_FOUND", "GST conversion record not found");

    // 2. Enforce the sequence/timing check
    const [latestGstSale] = await tx
      .select({ id: gstSalesHistory.id, created_at: gstSalesHistory.created_at })
      .from(gstSalesHistory)
      .orderBy(desc(gstSalesHistory.created_at))
      .limit(1);

    if (!latestGstSale || latestGstSale.id !== gstRow.id) {
      throw new AppError("BUSINESS_RULE_VIOLATION", "Only the most recent GST conversion can be undone");
    }

    // Check if 12 hours have passed
    const elapsedMs = Date.now() - new Date(gstRow.created_at).getTime();
    if (elapsedMs > 12 * 60 * 60 * 1000) {
      throw new AppError("BUSINESS_RULE_VIOLATION", "GST conversion can only be undone within 12 hours");
    }

    // 3. Delete the GST conversion copy
    await tx.delete(gstSalesHistory).where(eq(gstSalesHistory.id, gstRow.id));

    return { success: true };
  });
}
