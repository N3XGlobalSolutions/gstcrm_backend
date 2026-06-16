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
import { sql, inArray, eq, desc, count } from "drizzle-orm";
import { createSystemNotification } from "@/modules/notifications/service";
import { getAggregateBalances } from "@/lib/balance";
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
    .select({ sale_id: gstSalesHistory.sale_id })
    .from(gstSalesHistory)
    .where(inArray(gstSalesHistory.sale_id, groupIds));

  const convertedSet = new Set(convertedGroups.map((c) => c.sale_id));

  const enrichedData = result.data.map((d) => ({
    ...d,
    entries: txEntries.filter((e) => e.entry.group_id === d.group.id),
    isConverted: convertedSet.has(d.group.id),
  }));

  const finalEnrichedData = await Promise.all(
    enrichedData.map(async (d) => {
      // Opening balance = customer's aggregate up to (but not including) this group.
      const opening = await getAggregateBalances(
        d.group.account_id,
        new Date(d.group.created_at),
        d.group.id,
      );

      return {
        ...d,
        openingPure: opening.totalPure.toFixed(4),
        openingCash: opening.totalCash.toFixed(2),
        isConverted: d.isConverted,
      };
    }),
  );

  return { data: finalEnrichedData, total: result.total };
}

export async function getSaleById(input: z.infer<typeof GetByIdSchema>) {
  const tx = await getTransactionById(input.id);
  if (!tx) throw new AppError("NOT_FOUND", "Sale not found");
  return tx;
}

export async function createSale(
  input: z.infer<typeof CreateSalesSchema>,
  creator: { id: string; username: string },
  isUpdate: boolean = false,
  options?: { existingBillNo?: number; existingEntryNo?: number }
) {
  // Step 1 — Per-item wastage + pure calculations
  const processedItems = input.items.map((item) => {
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
    // Step 5 — Lock entry rows then read lot balance within the same transaction
    for (const item of processedItems) {
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
    }

    // Step 6 — Bill number per customer (uses tx so it's consistent with the insert)
    const bill_no = options?.existingBillNo ?? await generateBillNo(tx, input.account_id, "SALE");

    // Step 7 — Build entries and write to ledger (lock still held)
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
    const openingPure = parseFloat(opening.totalPure.toString() || "0");
    const openingCash = parseFloat(opening.totalCash.toString() || "0");

    const totalPaidCash = openingCash + bankPaidAmount;
    const balancePure = openingPure + currentPure - (rate > 0 ? totalPaidCash / rate : 0);
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
