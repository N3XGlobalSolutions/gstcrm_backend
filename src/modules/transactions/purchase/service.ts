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
  SettlePurchasePaymentSchema,
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

  // Only ONE bill in the whole Purchase History is ever editable — the single
  // most recently created real bill (highest entry_no; conversions carry no
  // bill_no and are excluded), across every supplier, not "each account's own
  // latest bill". Computed globally so it's correct regardless of which page,
  // filter, or sort the table is currently showing.
  const [globalLastBill] = await db
    .select({ id: entryGroups.id })
    .from(entryGroups)
    .where(
      and(
        eq(entryGroups.type, "PURCHASE"),
        eq(entryGroups.is_deleted, false),
        isNotNull(entryGroups.bill_no),
      ),
    )
    .orderBy(desc(entryGroups.entry_no))
    .limit(1);
  const globalLastBillId = globalLastBill?.id;

  const finalEnrichedData = enrichedData.map((d) => {
    const opening = batchBalances[d.group.id]!;

    // openingPure: prior net pure grams owed (negated — positive = shop owes supplier)
    const openingPureNum = -parseFloat(opening.balancePure.toString() || "0");

    // openingCash: prior net cash owed (negated — positive = shop owes supplier)
    const openingCashNum = -parseFloat(opening.totalCash.toString() || "0");

    const isLastBill = d.group.id === globalLastBillId;

    return {
      ...d,
      openingPure: openingPureNum.toFixed(4),
      openingCash: openingCashNum.toFixed(2),
      isConverted: d.isConverted,
      canUndoConversion: d.canUndoConversion,
      convertedAt: d.convertedAt,
      isLastBill,
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
  // TDS/TCS Adjustment entries are also structurally identical to a bank
  // payment (SHOP → supplier) but aren't real payments — exclude them the
  // same way Discount and Cash Purchase Charge are excluded, so the printed
  // Estimation's Cash Paid/Bank Paid split isn't inflated by tax adjustments.
  const paymentEntries = moneyEntries.filter((e) =>
    e.entry.remarks !== "Discount" &&
    e.entry.remarks !== "Cash Purchase Charge" &&
    e.entry.remarks !== "TDS Adjustment" &&
    e.entry.remarks !== "TCS Adjustment" &&
    e.entry.remarks !== "Round Off"
  );

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

  // Calculate total cash value and total pure weight for items.
  // Round each item's pure to 3dp (toQuantityString) before multiplying by rate —
  // same value PURE-mode entries below get written with (via entryBuilder's
  // calcPure/toQuantityString). Multiplying on the unrounded figure here produced a
  // "Cash Purchase Charge" that drifted a few rupees from what the item table/Total
  // Amount actually displays (mirrors the identical fix in sales/service.ts).
  let totalPurchaseCashVal = toDecimal(0);
  let totalPureQty = toDecimal(0);
  allItems.forEach((item) => {
    const qty = toDecimal(item.quantity);
    const pur = toDecimal(item.purity);
    const pure = toDecimal(toQuantityString(qty.times(pur).div(100)));
    const r = toDecimal(item.rate ?? input.rate_per_gram ?? '0');
    totalPurchaseCashVal = totalPurchaseCashVal.plus(pure.times(r));
    totalPureQty = totalPureQty.plus(pure);
  });

  // Overpayment guard removed by request — bank_amount is no longer capped
  // against the supplier's outstanding balance. A payment larger than what's
  // owed is now accepted and will push the balance negative.

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
    // TDS — subtracts from what the shop owes the supplier (SHOP → supplier:
    // same direction/effect as a discount).
    ...(input.tds_enabled && toDecimal(input.tds_amount ?? '0').gt(0)
      ? [
          {
            fromAccountId: SYSTEM_ACCOUNTS.SHOP_ID,
            toAccountId: input.account_id,
            itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID,
            quantity: toDecimal(input.tds_amount!).toFixed(2),
            remarks: 'TDS Adjustment',
          },
        ]
      : []),
    // TCS — adds to what the shop owes the supplier (supplier → SHOP: same
    // direction/effect as a Cash Purchase Charge).
    ...(input.tcs_enabled && toDecimal(input.tcs_amount ?? '0').gt(0)
      ? [
          {
            fromAccountId: input.account_id,
            toAccountId: SYSTEM_ACCOUNTS.SHOP_ID,
            itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID,
            quantity: toDecimal(input.tcs_amount!).toFixed(2),
            remarks: 'TCS Adjustment',
          },
        ]
      : []),
    // Round Off — settles the bill to a whole rupee IN THE LEDGER, not just on the
    // printed estimation. Previously the estimation computed this delta at print
    // time and only adjusted the displayed Closing Balance, so the sub-rupee
    // remainder stayed in the supplier's real balance and compounded bill after
    // bill (e.g. -0.16 carried into the next bill, which then closed at -0.48
    // while printing -0.16). Posting it here keeps the printed figures and the
    // ledger identical, and stops the paise accumulating.
    //
    // CASH mode only: a PURE-mode bill's value never touches the cash ledger, so
    // there is no cash remainder to round there.
    ...(() => {
      if (!isCashMode) return [];
      const tds = input.tds_enabled ? toDecimal(input.tds_amount ?? '0') : toDecimal('0');
      const tcs = input.tcs_enabled ? toDecimal(input.tcs_amount ?? '0') : toDecimal('0');
      const billBalance = totalPurchaseCashVal
        .minus(toDecimal(input.bank_amount || '0'))
        .minus(totalDiscountCash)
        .minus(tds)
        .plus(tcs);
      const roundOff = toDecimal(billBalance.toFixed(0)).minus(billBalance);
      // Nothing to post when the bill already lands on a whole rupee.
      if (roundOff.abs().lt(toDecimal('0.005'))) return [];
      return [
        roundOff.gt(0)
          ? {
              // Owed goes UP — supplier → SHOP, same direction as a Cash Purchase Charge.
              fromAccountId: input.account_id,
              toAccountId: SYSTEM_ACCOUNTS.SHOP_ID,
              itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID,
              quantity: roundOff.toFixed(2),
              remarks: 'Round Off',
            }
          : {
              // Owed goes DOWN — SHOP → supplier, same direction as a discount.
              fromAccountId: SYSTEM_ACCOUNTS.SHOP_ID,
              toAccountId: input.account_id,
              itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID,
              quantity: roundOff.abs().toFixed(2),
              remarks: 'Round Off',
            },
      ];
    })(),
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
 * Computes a single purchase bill's own cash value, what's been paid against it
 * (bank/cash payments + discount), and what's still owed — independent of the
 * account's running balance (which can carry an unrelated prior debt/credit).
 * Mirrors the exact math the frontend uses in PurchaseHistoryTable so the two
 * never disagree on what counts as "this bill's balance".
 */
async function computePurchaseBillStatus(groupId: string) {
  const [group] = await db
    .select()
    .from(entryGroups)
    .where(eq(entryGroups.id, groupId))
    .limit(1);

  if (!group || group.type !== "PURCHASE" || group.is_deleted) {
    throw new AppError("NOT_FOUND", "Purchase not found");
  }

  const rows = await db
    .select({ entry: entriesTable, item_type: itemsTable.type })
    .from(entriesTable)
    .leftJoin(itemsTable, eq(entriesTable.item_id, itemsTable.id))
    .where(eq(entriesTable.group_id, groupId));

  const remarksText = group.remarks || "";
  const isConversionEntry =
    remarksText.startsWith("Gold to Cash Conversion") || remarksText.startsWith("Cash to Gold Conversion");

  const goldEntries = rows.filter((r) => r.item_type === "GOLD" || r.item_type === "ORNAMENT");
  const moneyEntries = rows.filter((r) => r.item_type === "MONEY");
  const cashChargeEntries = moneyEntries.filter((r) => r.entry.remarks === "Cash Purchase Charge");
  // A "Discount" entry is written SHOP → supplier — the same direction as a real
  // bank/cash payment (see createPurchase) — so it must be pulled out by remarks,
  // not by direction (from_account_id === group.account_id would never match a
  // real discount entry and silently classify it as a payment instead).
  // TDS SUBTRACTS from what's owed (SHOP → supplier, same direction/effect as a
  // discount) and TCS ADDS to it (supplier → SHOP, same direction/effect as a
  // Cash Purchase Charge). Both need pulling out by remarks for the same reason
  // Discount does.
  // "Round Off" is likewise structurally identical to a payment when it lowers
  // what's owed (SHOP → supplier), so it must be pulled out by remarks too.
  const isSpecial = (r: (typeof rows)[number]) =>
    r.entry.remarks === "Cash Purchase Charge" ||
    r.entry.remarks === "Discount" ||
    r.entry.remarks === "TDS Adjustment" ||
    r.entry.remarks === "TCS Adjustment" ||
    r.entry.remarks === "Round Off" ||
    isConversionEntry;
  const bankEntries = moneyEntries.filter((r) => !isSpecial(r) && r.entry.to_account_id === group.account_id);
  const discountEntries = moneyEntries.filter((r) => r.entry.remarks === "Discount");
  const tdsEntries = moneyEntries.filter((r) => r.entry.remarks === "TDS Adjustment");
  const tcsEntries = moneyEntries.filter((r) => r.entry.remarks === "TCS Adjustment");
  const roundOffEntries = moneyEntries.filter((r) => r.entry.remarks === "Round Off");

  const rate = parseFloat(group.rate_per_gram || "0");
  const cashChargeAmount = cashChargeEntries.reduce((s, r) => s + parseFloat(r.entry.quantity || "0"), 0);
  const currentCash =
    goldEntries.reduce((s, r) => {
      const p = parseFloat(r.entry.pure_quantity || "0");
      const er = parseFloat(r.entry.rate || "") || rate;
      return s + p * er;
    }, 0) + cashChargeAmount;
  const bankPaid = bankEntries.reduce((s, r) => s + parseFloat(r.entry.quantity || "0"), 0);
  const discountCash = discountEntries.reduce((s, r) => s + parseFloat(r.entry.quantity || "0"), 0);
  const tdsCash = tdsEntries.reduce((s, r) => s + parseFloat(r.entry.quantity || "0"), 0);
  const tcsCash = tcsEntries.reduce((s, r) => s + parseFloat(r.entry.quantity || "0"), 0);
  // Round Off is signed by direction: supplier → SHOP raises what's owed,
  // SHOP → supplier lowers it (see createPurchase). Folding it in here is what
  // makes a rounded bill actually report balance 0 instead of a few stray paise.
  const roundOffCash = roundOffEntries.reduce(
    (s, r) =>
      s +
      (r.entry.from_account_id === group.account_id ? 1 : -1) *
        parseFloat(r.entry.quantity || "0"),
    0,
  );
  const paid = bankPaid + discountCash + tdsCash - tcsCash;
  const balance = Math.round((currentCash - paid + roundOffCash) * 100) / 100;

  return {
    group,
    isConversionEntry,
    currentCash: Math.round(currentCash * 100) / 100,
    paid: Math.round(paid * 100) / 100,
    balance,
  };
}

/** Live payment status for a single purchase bill — powers the Pay popup. */
export async function getPurchasePaymentStatus(input: z.infer<typeof GetByIdSchema>) {
  const status = await computePurchaseBillStatus(input.id);
  return {
    currentCash: status.currentCash,
    paid: status.paid,
    balance: status.balance,
    isConversionEntry: status.isConversionEntry,
  };
}

/**
 * Records an additional cash/bank payment against an existing purchase bill
 * (the red "partially paid" rows in Purchase History) without editing or
 * reversing the bill. Inserts a single MONEY entry into the bill's own
 * entry_group — SHOP → supplier, exactly like the bank-payment entry
 * createPurchase writes at bill creation, so it's picked up by every existing
 * balance/history query with no special-casing needed.
 *
 * The amount is capped at this bill's own remaining balance — overpayment
 * through this popup is rejected outright rather than turned into a credit.
 */
export async function settlePurchasePayment(input: z.infer<typeof SettlePurchasePaymentSchema>) {
  const status = await computePurchaseBillStatus(input.id);

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
      from_account_id: SYSTEM_ACCOUNTS.SHOP_ID,
      to_account_id: status.group.account_id,
      item_id: SYSTEM_ITEMS.RUPEE_ITEM_ID,
      quantity: amount.toFixed(2),
      remarks,
    })
    .returning();

  if (!inserted) throw new AppError("INTERNAL_ERROR", "Failed to record payment");

  const updated = await computePurchaseBillStatus(input.id);

  return {
    entry: inserted,
    currentCash: updated.currentCash,
    paid: updated.paid,
    balance: updated.balance,
  };
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
  // Rounded to milligrams (3dp, the ledger's own gram precision) before comparing.
  const openingPure = toDecimal(opening.balancePure.negated().toFixed(3)); // positive = shop owes supplier

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
    skipBillNo: true,
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
  // Rounded to paisa before comparing — see createPurchase's guard for why.
  const openingCash = toDecimal(opening.totalCash.negated().toFixed(2)); // positive = shop owes supplier

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
    skipBillNo: true,
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
      account_id: entryGroups.account_id,
    })
    .from(entryGroups)
    .where(eq(entryGroups.id, input.id))
    .limit(1);

  if (!originalGroup) {
    throw new AppError("NOT_FOUND", "Purchase not found");
  }

  // Only the account's most recent purchase bill may be edited. Editing an
  // older bill re-stamps its created_at to "now" (reverseEntryGroup + the
  // recreate below both insert fresh rows, with no created_at override) — every
  // balance query orders/filters strictly by created_at, so that silently
  // reorders this bill past every transaction that happened for the account in
  // between, corrupting the running balance history from that point forward.
  // The UI already restricts the Edit action to the last bill per account, but
  // that check is client-side and scoped to the current page/sort/filter — this
  // is the authoritative guard.
  if (originalGroup.bill_no !== null) {
    const [newerBill] = await db
      .select({ id: entryGroups.id })
      .from(entryGroups)
      .where(
        and(
          eq(entryGroups.account_id, originalGroup.account_id),
          eq(entryGroups.type, "PURCHASE"),
          eq(entryGroups.is_deleted, false),
          not(eq(entryGroups.id, input.id)),
          sql`${entryGroups.bill_no} > ${originalGroup.bill_no}`,
        ),
      )
      .limit(1);

    if (newerBill) {
      throw new AppError(
        "BUSINESS_RULE_VIOLATION",
        "Only the most recent purchase bill for this supplier can be edited.",
      );
    }
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
  input: { id: string; gst_amount: string; tds_amount: string; tcs_amount: string; details?: string }
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
        details: input.details,
      })
      .returning();

    if (!inserted) throw new AppError("INTERNAL_ERROR", "Failed to create GST Purchase copy");

    return inserted;
  });
}

/**
 * The saved GST conversion record for a purchase bill, if it has one — the
 * printed GST bill uses this as its source of truth (via the `details` JSON
 * snapshot) instead of recalculating the tax breakdown from the ledger, which
 * could silently drift from what the user actually confirmed on the
 * conversion popup (different rate-per-item handling, missing cash-charge
 * amounts, etc).
 */
export async function getGSTPurchaseConversion(purchaseId: string) {
  const [row] = await db
    .select()
    .from(gstPurchaseHistory)
    .where(eq(gstPurchaseHistory.purchase_id, purchaseId))
    .orderBy(desc(gstPurchaseHistory.created_at))
    .limit(1);

  return row ?? null;
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
