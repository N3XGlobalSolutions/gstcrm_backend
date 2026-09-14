import { AppError } from "@/types/errors";
import { createEntryGroup } from "@/lib/entryBuilder";
import { reverseEntryGroup } from "@/lib/reversal";
import { generateEntryGroupNo } from "@/lib/entryNoGenerator";
import {
  calcWastagePercent,
  calcWastageGram,
  toDecimal,
  toQuantityString,
  Decimal,
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
  ConvertGoldToCashSchema,
  ConvertCashToGoldSchema,
  SettleSalePaymentSchema,
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

  // Only ONE bill in the whole Sales History is ever editable — the single
  // most recently created real bill (highest entry_no; conversions carry no
  // bill_no and are excluded), across every customer, not "each account's own
  // latest bill". Computed globally so it's correct regardless of which page,
  // filter, or sort the table is currently showing — mirrors the same fix
  // applied to Purchase's listPurchases.
  const [globalLastBill] = await db
    .select({ id: entryGroups.id })
    .from(entryGroups)
    .where(
      and(
        eq(entryGroups.type, "SALE"),
        eq(entryGroups.is_deleted, false),
        isNotNull(entryGroups.bill_no),
      ),
    )
    .orderBy(desc(entryGroups.entry_no))
    .limit(1);
  const globalLastBillId = globalLastBill?.id;

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
      isLastBill: d.group.id === globalLastBillId,
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

/**
 * Computes a single sale bill's own cash value, what's been received against it
 * (bank/cash payment + discount + TDS — TDS reduces the customer's payable the
 * same way a discount does, TCS increases it the same way a Cash Sale Charge
 * does), and what's still owed — independent of the account's running balance.
 * Mirrors EXACTLY the math SalesHistoryTable.tsx uses for isPartiallyPaid/
 * isFullyPaid, so this never disagrees with what the red "partially paid" row
 * on screen shows.
 */
async function computeSaleBillStatus(groupId: string) {
  const [group] = await db
    .select()
    .from(entryGroups)
    .where(eq(entryGroups.id, groupId))
    .limit(1);

  if (!group || group.type !== "SALE" || group.is_deleted) {
    throw new AppError("NOT_FOUND", "Sale not found");
  }

  const rows = await db
    .select({ entry: entriesTable, item_type: itemsTable.type })
    .from(entriesTable)
    .leftJoin(itemsTable, eq(entriesTable.item_id, itemsTable.id))
    .where(eq(entriesTable.group_id, groupId));

  const remarksText = group.remarks || "";
  const isConversionEntry =
    remarksText.startsWith("Gold to Cash Conversion") || remarksText.startsWith("Cash to Gold Conversion");

  const itemEntries = rows.filter((r) => r.item_type === "GOLD" || r.item_type === "ORNAMENT");
  const moneyEntries = rows.filter((r) => r.item_type === "MONEY");

  const rate = parseFloat(group.rate_per_gram || "0");
  const currentPure = itemEntries.reduce((s, r) => s + parseFloat(r.entry.pure_quantity || "0"), 0);
  const cashChargeAmount = moneyEntries
    .filter((r) => r.entry.remarks === "Cash Sale Charge")
    .reduce((s, r) => s + parseFloat(r.entry.quantity || "0"), 0);
  const currentCash = currentPure * rate + cashChargeAmount;

  const bankPaidAmount = moneyEntries
    .filter(
      (r) =>
        r.entry.remarks !== "Cash Sale Charge" &&
        r.entry.remarks !== "Discount" &&
        r.entry.remarks !== "TDS Adjustment" &&
        r.entry.remarks !== "TCS Adjustment" &&
        r.entry.remarks !== "Round Off" &&
        !isConversionEntry &&
        r.entry.from_account_id === group.account_id,
    )
    .reduce((s, r) => s + parseFloat(r.entry.quantity || "0"), 0);
  const discountAmount = moneyEntries
    .filter((r) => r.entry.remarks === "Discount")
    .reduce((s, r) => s + parseFloat(r.entry.quantity || "0"), 0);
  const tdsCash = moneyEntries
    .filter((r) => r.entry.remarks === "TDS Adjustment")
    .reduce((s, r) => s + parseFloat(r.entry.quantity || "0"), 0);
  const tcsCash = moneyEntries
    .filter((r) => r.entry.remarks === "TCS Adjustment")
    .reduce((s, r) => s + parseFloat(r.entry.quantity || "0"), 0);

  // Round Off is signed by direction: SHOP → customer raises what's owed,
  // customer → SHOP lowers it (see createSale). Folding it in here is what makes
  // a rounded bill actually report balance 0 instead of a few stray paise.
  const roundOffCash = moneyEntries
    .filter((r) => r.entry.remarks === "Round Off")
    .reduce(
      (s, r) =>
        s +
        (r.entry.to_account_id === group.account_id ? 1 : -1) *
          parseFloat(r.entry.quantity || "0"),
      0,
    );

  const paid = bankPaidAmount + discountAmount + tdsCash - tcsCash;
  const balance = Math.round((currentCash - paid + roundOffCash) * 100) / 100;

  return {
    group,
    isConversionEntry,
    currentCash: Math.round(currentCash * 100) / 100,
    paid: Math.round(paid * 100) / 100,
    balance,
  };
}

/** Live payment status for a single sale bill — powers the Pay popup. */
export async function getSalePaymentStatus(input: z.infer<typeof GetByIdSchema>) {
  const status = await computeSaleBillStatus(input.id);
  return {
    currentCash: status.currentCash,
    paid: status.paid,
    balance: status.balance,
    isConversionEntry: status.isConversionEntry,
  };
}

/**
 * Records an additional cash/bank payment received against an existing sale
 * bill (the red "partially paid" rows in Sales History) without editing or
 * reversing the bill. Inserts a single MONEY entry into the bill's own
 * entry_group — customer → SHOP, exactly like the payment entry createSale
 * writes at bill creation, so it's picked up by every existing balance/
 * history query with no special-casing needed.
 *
 * The amount is capped at this bill's own remaining balance — overpayment
 * through this popup is rejected outright rather than turned into a credit.
 */
export async function settleSalePayment(input: z.infer<typeof SettleSalePaymentSchema>) {
  const status = await computeSaleBillStatus(input.id);

  if (status.isConversionEntry) {
    throw new AppError("BUSINESS_RULE_VIOLATION", "Conversion entries have no bill balance to settle.");
  }

  if (status.balance <= 0) {
    throw new AppError("BUSINESS_RULE_VIOLATION", "This bill is already fully paid.");
  }

  const amount = toDecimal(input.amount);
  const balance = toDecimal(status.balance.toFixed(2));
  if (amount.gt(balance.plus(0.01))) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Payment cannot exceed the balance due (₹${balance.toFixed(2)}).`,
    );
  }

  if (input.method === "BANK" && !input.bank_details?.trim()) {
    throw new AppError("VALIDATION_ERROR", "Select a bank account.");
  }

  const remarks = input.method === "CASH" ? "Cash" : input.bank_details!.trim();

  const [inserted] = await db
    .insert(entriesTable)
    .values({
      group_id: input.id,
      from_account_id: status.group.account_id,
      to_account_id: SYSTEM_ACCOUNTS.SHOP_ID,
      item_id: SYSTEM_ITEMS.RUPEE_ITEM_ID,
      quantity: amount.toFixed(2),
      remarks,
    })
    .returning();

  if (!inserted) throw new AppError("INTERNAL_ERROR", "Failed to record payment");

  const updated = await computeSaleBillStatus(input.id);

  return {
    entry: inserted,
    currentCash: updated.currentCash,
    paid: updated.paid,
    balance: updated.balance,
  };
}

/**
 * Converts part of a customer's outstanding pure-gold balance into a cash debt.
 *
 * Mirror of the Purchase-side conversion, but with entry directions reversed:
 * Sales accounts use the RAW (unnegated) balancePure/totalCash as "positive =
 * customer owes shop" (see SalesPage.tsx's opening-balance fetch — no negation
 * applied there), whereas Purchase negates. Both entries use RUPEE_ITEM_ID and
 * SHOP_ID as the counterparty so neither is picked up by item-level stock
 * queries — stock-on-hand stays untouched, same as the Purchase-side version.
 *
 * Entry 1 reduces gold owed: customer → SHOP, pureQuantity override = gold_grams,
 * quantity "0" (no cash effect). Entry 2 raises cash owed: SHOP → customer,
 * quantity = cash_amount.
 */
export async function convertGoldToCash(input: z.infer<typeof ConvertGoldToCashSchema>) {
  const goldGrams = toDecimal(input.gold_grams);
  // Derived, not trusted from the client — see schema.ts for why.
  const cashAmount = goldGrams.times(toDecimal(input.rate_per_gram));

  const opening = await getAggregateBalances(input.account_id);
  // Rounded to milligrams (3dp, the ledger's own gram precision) before comparing.
  const openingPure = toDecimal(opening.balancePure.toFixed(3)); // raw, unnegated — positive = customer owes shop

  if (openingPure.lte(0)) {
    throw new AppError("BUSINESS_RULE_VIOLATION", "This customer has no outstanding gold balance to convert.");
  }
  if (goldGrams.gt(openingPure.plus(0.001))) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Cannot convert ${goldGrams.toFixed(3)}g — only ${openingPure.toFixed(3)}g of gold is outstanding for this customer.`,
    );
  }

  const today = new Date().toISOString().split("T")[0]!;
  const label = `Gold to Cash Conversion (${goldGrams.toFixed(3)}g @ ₹${toDecimal(input.rate_per_gram).toFixed(2)}/g)`;

  const { group, entries: createdEntries } = await createEntryGroup({
    type: "SALE",
    accountId: input.account_id,
    date: today,
    ratePerGram: input.rate_per_gram,
    remarks: label,
    skipBillNo: true,
    entries: [
      {
        // Reduces gold owed by the customer
        fromAccountId: input.account_id,
        toAccountId: SYSTEM_ACCOUNTS.SHOP_ID,
        itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID,
        quantity: "0",
        pureQuantity: goldGrams.toFixed(3),
        remarks: label,
      },
      {
        // Raises cash owed by the customer
        fromAccountId: SYSTEM_ACCOUNTS.SHOP_ID,
        toAccountId: input.account_id,
        itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID,
        quantity: cashAmount.toFixed(2),
        remarks: label,
      },
    ],
  });

  return { group, entries: createdEntries };
}

/**
 * The opposite of convertGoldToCash: converts part of a customer's outstanding
 * cash debt into a pure-gold debt, at an agreed rate.
 */
export async function convertCashToGold(input: z.infer<typeof ConvertCashToGoldSchema>) {
  const cashAmount = toDecimal(input.cash_amount);
  const rate = toDecimal(input.rate_per_gram);
  // Derived, not trusted from the client — see schema.ts for why.
  const goldGrams = cashAmount.div(rate);

  const opening = await getAggregateBalances(input.account_id);
  // Rounded to paisa before comparing — see createSale's guard for why.
  const openingCash = toDecimal(opening.totalCash.toFixed(2)); // raw, unnegated — positive = customer owes shop

  if (openingCash.lte(0)) {
    throw new AppError("BUSINESS_RULE_VIOLATION", "This customer has no outstanding cash balance to convert.");
  }
  if (cashAmount.gt(openingCash.plus(0.01))) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Cannot convert ₹${cashAmount.toFixed(2)} — only ₹${openingCash.toFixed(2)} of cash is outstanding for this customer.`,
    );
  }

  const today = new Date().toISOString().split("T")[0]!;
  const label = `Cash to Gold Conversion (${goldGrams.toFixed(3)}g @ ₹${toDecimal(input.rate_per_gram).toFixed(2)}/g)`;

  const { group, entries: createdEntries } = await createEntryGroup({
    type: "SALE",
    accountId: input.account_id,
    date: today,
    ratePerGram: input.rate_per_gram,
    remarks: label,
    skipBillNo: true,
    entries: [
      {
        // Reduces cash owed by the customer
        fromAccountId: input.account_id,
        toAccountId: SYSTEM_ACCOUNTS.SHOP_ID,
        itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID,
        quantity: cashAmount.toFixed(2),
        remarks: label,
      },
      {
        // Raises gold owed by the customer
        fromAccountId: SYSTEM_ACCOUNTS.SHOP_ID,
        toAccountId: input.account_id,
        itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID,
        quantity: "0",
        pureQuantity: goldGrams.toFixed(3),
        remarks: label,
      },
    ],
  });

  return { group, entries: createdEntries };
}

export async function createSale(
  input: z.infer<typeof CreateSalesSchema>,
  creator: { id: string; username: string },
  isUpdate: boolean = false,
  options?: { existingBillNo?: number; existingEntryNo?: number; groupId?: string }
) {
  // Step 1 — Per-item wastage + pure calculations
  const processedItems = input.items.map((item) => {
    // PERCENT wastage divides BY the purity (weight × wastage% ÷ touch), so a zero
    // touch is only a problem when wastage is actually being applied. Touch 0 is a
    // legitimate value on its own — the row just bills as zero pure — so guard on the
    // division, not on the touch alone. Without this, every touch-0 row was rejected
    // here purely because PERCENT is the grid's default mode, even with no wastage.
    const hasPercentWastage =
      item.wastage_mode === "PERCENT" && toDecimal(item.wastage_value || "0").gt(0);
    if (hasPercentWastage && toDecimal(item.purity).lte(0)) {
      throw new AppError(
        "BUSINESS_RULE_VIOLATION",
        "Purity must be greater than zero when applying PERCENT wastage"
      );
    }
    const wastageQty =
      item.wastage_mode === "PERCENT"
        ? (hasPercentWastage
            ? calcWastagePercent(item.quantity, item.wastage_value, item.purity)
            : toDecimal("0"))
        : calcWastageGram(item.quantity, item.wastage_value);

    const totalQuantity = toDecimal(item.quantity).plus(wastageQty);
    const totalQuantityStr = toQuantityString(totalQuantity);

    // Gross pure = (physical weight + wastage) × touch/100. This is the VALUE the
    // customer is billed for (wastage = the shop's profit). It is written to the
    // ledger as a pure_quantity override, while only the PHYSICAL weight leaves
    // stock — wastage on a sale must never be deducted from physical gold.
    const grossPureStr = toQuantityString(totalQuantity.mul(toDecimal(item.purity).div(100)));

    return { ...item, totalQuantityStr, grossPureStr, wastageQty: toQuantityString(wastageQty) };
  });

  // Steps 5–7 inside one transaction so the SELECT FOR UPDATE lock is held
  // through the insert — prevents two concurrent sales from overselling the same lot.
  return db.transaction(async (tx) => {
    // Overpayment guard removed by request — bank_amount is no longer capped
    // against the customer's outstanding balance. A payment larger than what's
    // owed is now accepted and will push the balance negative.
    const ratePerGram = toDecimal(input.rate_per_gram);
    // Sum the already-rounded per-item grossPureStr (same value used for the PURE-mode
    // ledger entries below) rather than recomputing totalQuantity × touch fresh — doing
    // the multiplication again here on unrounded figures produced a "Cash Sale Charge"
    // amount that silently drifted a few paise from what the item table/Total Amount
    // actually displays (e.g. 93996.40 instead of 94000.00 on a 9.400g bill).
    const pureValuePure = processedItems.reduce((acc, item) => {
      return acc.plus(toDecimal(item.grossPureStr));
    }, toDecimal(0));
    // Touch 0 = DIRECT sale: sold by weight at the bill rate, not by pure gold. Its
    // value is (weight + wastage) × rate and it contributes no pure (grossPureStr is
    // already 0). Without this the row billed as ₹0.
    const directItems = processedItems.filter((item) => toDecimal(item.purity).isZero());
    const directValueCash = directItems.reduce(
      (acc, item) => acc.plus(toDecimal(item.totalQuantityStr).mul(ratePerGram)),
      toDecimal(0),
    );
    const pureValueCash = pureValuePure.mul(ratePerGram).plus(directValueCash);

    if (directItems.length > 0 && input.balance_mode !== "CASH") {
      throw new AppError(
        "BUSINESS_RULE_VIOLATION",
        "Direct sale items (touch 0) are valued in cash — set Maintain In to Cash",
      );
    }

    const discountCash = toDecimal(input.discount ?? "0");
    const discountPure = toDecimal(input.discount_pure ?? "0");
    const discountPureAsCash = discountPure.mul(ratePerGram);

    // Step 5 — Lock entry rows then check stock availability
    // Gold: Checked in pooled mode (all lots combined).
    // Ornament: Checked per specific lot_id (lot_id is strictly required).
    const dbItems = await tx
      .select({ id: itemsTable.id, type: itemsTable.type, name: itemsTable.name })
      .from(itemsTable)
      .where(inArray(itemsTable.id, processedItems.map(item => item.item_id)));

    await Promise.all(
      processedItems.map(async (item) => {
        const itemMeta = dbItems.find(d => d.id === item.item_id);
        if (!itemMeta) {
          throw new AppError("NOT_FOUND", `Item ${item.item_id} not found`);
        }

        if (itemMeta.type === "ORNAMENT") {
          if (!item.lot_id) {
            throw new AppError("VALIDATION_ERROR", `Lot ID is required for ornament: ${itemMeta.name}`);
          }
          await tx.execute(
            sql`SELECT id FROM ${entries}
                WHERE item_id = ${item.item_id}
                  AND lot_id = ${item.lot_id}
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
          // Only the PHYSICAL weight is checked/consumed — wastage is a profit
          // line billed via pure_quantity, not physical gold leaving the lot.
          if (available.lt(toDecimal(item.quantity))) {
            throw new AppError(
              "BUSINESS_RULE_VIOLATION",
              `Insufficient stock for ornament ${itemMeta.name} in lot ${item.lot_id}. Available: ${available.toFixed(3)}g, Required: ${item.quantity}g`,
            );
          }
        } else {
          // GOLD (pooled mode)
          await tx.execute(
            sql`SELECT id FROM ${entries}
                WHERE item_id = ${item.item_id}
                  AND (to_account_id = ${SYSTEM_ACCOUNTS.SHOP_ID} OR from_account_id = ${SYSTEM_ACCOUNTS.SHOP_ID})
                FOR UPDATE`,
          );
          const [row] = await tx.execute<{ available: string }>(
            sql`SELECT COALESCE(SUM(CASE WHEN to_account_id = ${SYSTEM_ACCOUNTS.SHOP_ID} THEN quantity ELSE -quantity END), 0)::text AS available
                FROM ${entries}
                WHERE item_id = ${item.item_id}
                  AND (to_account_id = ${SYSTEM_ACCOUNTS.SHOP_ID} OR from_account_id = ${SYSTEM_ACCOUNTS.SHOP_ID})`,
          );
          const available = toDecimal(row?.available ?? "0");
          // Physical weight only (see ornament branch) — wastage is profit, not gold.
          if (available.lt(toDecimal(item.quantity))) {
            throw new AppError(
              "BUSINESS_RULE_VIOLATION",
              `Insufficient stock for item ${itemMeta.name}. Available: ${available.toFixed(3)}g, Required: ${item.quantity}g`,
            );
          }
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

    const isCashMode = input.balance_mode === "CASH";

    const entryInputs = [
      ...processedItems.map((item) => ({
        fromAccountId: SYSTEM_ACCOUNTS.SHOP_ID,
        toAccountId: input.account_id,
        itemId: item.item_id,
        lotId: item.lot_id,
        quantity: item.quantity,          // physical weight only → correct stock
        // In CASH mode, the customer is billed in cash, so gold pure balance is NOT affected (pureQuantity = 0).
        // In PURE mode, customer owes pure gold (pureQuantity = grossPureStr).
        pureQuantity: isCashMode ? "0" : item.grossPureStr,
        purity: item.purity,
        wastageMode: item.wastage_mode as "PERCENT" | "GRAM",
        wastageValue: item.wastage_value,
        pieceCount: item.piece_count,
      })),
      // In CASH mode: record the total cash value of the sale as a cash debit on the customer's account
      ...(isCashMode && pureValueCash.gt(0)
        ? [
            {
              fromAccountId: SYSTEM_ACCOUNTS.SHOP_ID,
              toAccountId: input.account_id,
              itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID,
              quantity: pureValueCash.toFixed(2),
              remarks: "Cash Sale Charge",
            },
          ]
        : []),
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
      // CUSTOMER → SHOP: an outflow for the customer, same direction as a payment,
      // so it reduces their net payable. (Previously coded SHOP → CUSTOMER, which
      // is an inflow that INCREASES the customer's balance — the opposite of what
      // this comment and the frontend's preview formula, `- tdsAmount + tcsAmount`
      // in SalesBillingDetails.tsx, both assume.)
      ...(input.tds_enabled && toDecimal(input.tds_amount ?? "0").gt(0)
        ? [
            {
              fromAccountId: input.account_id,
              toAccountId: SYSTEM_ACCOUNTS.SHOP_ID,
              itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID,
              quantity: toDecimal(input.tds_amount!).toFixed(2),
              remarks: "TDS Adjustment",
            },
          ]
        : []),
      // TCS — customer pays extra TCS to the shop (increases customer's payable).
      // SHOP → CUSTOMER: an inflow for the customer, same direction as a new
      // charge, so it increases their net payable. (Previously coded
      // CUSTOMER → SHOP, which is an outflow that DECREASES the customer's
      // balance — the opposite of what this comment intends.)
      ...(input.tcs_enabled && toDecimal(input.tcs_amount ?? "0").gt(0)
        ? [
            {
              fromAccountId: SYSTEM_ACCOUNTS.SHOP_ID,
              toAccountId: input.account_id,
              itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID,
              quantity: toDecimal(input.tcs_amount!).toFixed(2),
              remarks: "TCS Adjustment",
            },
          ]
        : []),
      // Round Off — settles the bill to a whole rupee IN THE LEDGER, not just on
      // the printed estimation. Previously computed at print time and applied only
      // to the displayed Closing Balance, so the sub-rupee remainder stayed in the
      // customer's real balance and compounded bill after bill. Posting it here
      // keeps the printed figures and the ledger identical.
      // CASH mode only — a PURE-mode bill never touches the cash ledger.
      ...(() => {
        if (!isCashMode) return [];
        const tds = input.tds_enabled ? toDecimal(input.tds_amount ?? "0") : toDecimal("0");
        const tcs = input.tcs_enabled ? toDecimal(input.tcs_amount ?? "0") : toDecimal("0");
        const billBalance = pureValueCash
          .minus(toDecimal(input.bank_amount || "0"))
          .minus(totalDiscountCash)
          .minus(tds)
          .plus(tcs);
        const roundOff = toDecimal(billBalance.toFixed(0)).minus(billBalance);
        if (roundOff.abs().lt(toDecimal("0.005"))) return [];
        return [
          roundOff.gt(0)
            ? {
                // Customer owes MORE — SHOP → customer, same direction as a Cash Sale Charge.
                fromAccountId: SYSTEM_ACCOUNTS.SHOP_ID,
                toAccountId: input.account_id,
                itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID,
                quantity: roundOff.toFixed(2),
                remarks: "Round Off",
              }
            : {
                // Customer owes LESS — customer → SHOP, same direction as a discount.
                fromAccountId: input.account_id,
                toAccountId: SYSTEM_ACCOUNTS.SHOP_ID,
                itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID,
                quantity: roundOff.abs().toFixed(2),
                remarks: "Round Off",
              },
        ];
      })(),
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
      account_id: entryGroups.account_id,
    })
    .from(entryGroups)
    .where(eq(entryGroups.id, input.id))
    .limit(1);

  if (!originalGroup) {
    throw new AppError("NOT_FOUND", "Sale not found");
  }

  // Only the account's most recent sale bill may be edited — same guard as
  // Purchase's updatePurchase, for the same reason: editing an older bill
  // re-stamps its created_at to "now", silently reordering it past every
  // transaction that happened for the account in between and corrupting the
  // running balance history. The UI already restricts Edit to the last bill
  // per account, but that check is client-side and page/sort/filter-scoped.
  if (originalGroup.bill_no !== null) {
    const [newerBill] = await db
      .select({ id: entryGroups.id })
      .from(entryGroups)
      .where(
        and(
          eq(entryGroups.account_id, originalGroup.account_id),
          eq(entryGroups.type, "SALE"),
          eq(entryGroups.is_deleted, false),
          not(eq(entryGroups.id, input.id)),
          sql`${entryGroups.bill_no} > ${originalGroup.bill_no}`,
        ),
      )
      .limit(1);

    if (newerBill) {
      throw new AppError(
        "BUSINESS_RULE_VIOLATION",
        "Only the most recent sale bill for this customer can be edited.",
      );
    }
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
  input: { id: string; gst_amount: string; tds_amount: string; tcs_amount: string; details?: string }
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
        details: input.details,
      })
      .returning();

    if (!inserted) throw new AppError("INTERNAL_ERROR", "Failed to create GST copy");

    return inserted;
  });
}

/**
 * The saved GST conversion record for a sale bill, if it has one — the
 * printed GST bill uses this as its source of truth (via the `details` JSON
 * snapshot) instead of recalculating the tax breakdown from the ledger.
 */
export async function getGSTSaleConversion(saleId: string) {
  const [row] = await db
    .select()
    .from(gstSalesHistory)
    .where(eq(gstSalesHistory.sale_id, saleId))
    .orderBy(desc(gstSalesHistory.created_at))
    .limit(1);

  return row ?? null;
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
