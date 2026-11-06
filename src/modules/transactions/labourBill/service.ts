import { AppError } from "@/types/errors";
import { assertDeletableLastBill } from "@/lib/deleteGuards";
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
import { entries as entriesTable, items as itemsTable, entryGroups, labourBillCycles } from "@/db/schema";
import { inArray, eq, and, desc, sql, not, isNotNull } from "drizzle-orm";
import type { z } from "zod";
import {
  CreateLabourBillSchema,
  UpdateLabourBillSchema,
  CreateCycleSchema,
  type ListTxSchema,
  type GetByIdSchema,
  type DeleteTxSchema,
  type ListCyclesSchema,
  type GetCycleDetailSchema,
  type ConvertGoldToCashSchema,
  type ConvertCashToGoldSchema,
  type ReceiveCashSchema,
} from "./schema";
import {
  applyCycleCloseFlag,
  applyCycleRequiredTouch,
  assertCycleTakesBills,
  insertNextCycle,
  buildCycleSummary,
  loadCycleJobWorks,
  lockCycleForBill,
} from "./cycleLink";

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
  // Validate on every call path (tRPC or direct): Required Touch is mandatory on
  // a new cycle — it is asked once, here.
  const parsed = CreateCycleSchema.parse(input);
  // Same numbering as a Labour Bill's "New cycle" (account row lock → MAX+1).
  return db.transaction((tx) =>
    insertNextCycle(tx, {
      account_id: parsed.account_id,
      main_reason: parsed.main_reason ?? null,
      required_touch: parsed.required_touch,
    }),
  );
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

  // 2b. Job Works linked to this customer cycle (employee side) — 0026.
  const jobWorks = await loadCycleJobWorks(input.cycle_id);

  // 3. Fetch all entries for those groups
  const groupIds = groups.map((g) => g.group.id);
  const txEntries = groupIds.length === 0 ? [] : await db
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

  // Customer side (this cycle's labour bills) and employee side (linked job
  // works) are summarised separately — never mixed into one number.
  // groups holds only LABOUR_BILL groups in practice (bill_cycle_id is set on
  // labour bills only), but filter to be safe.
  const summary = buildCycleSummary(
    enrichedGroups.filter((g) => g.group.type === "LABOUR_BILL"),
    jobWorks,
  );

  return { cycle, groups: enrichedGroups, job_works: jobWorks, summary };
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

// ─── Cycle check for a labour bill save ───────────────────────────────────────
// The cycle must exist and belong to the bill's customer. A DELIVERED cycle takes
// no NEW bill; editing a bill that is already on it stays allowed
// (existingCycleId = the cycle the stored bill is on).

async function assertLabourBillCycle(
  cycleId: string,
  accountId: string,
  existingCycleId?: string | null,
) {
  const [cycle] = await db
    .select({
      id: labourBillCycles.id,
      bill_no: labourBillCycles.bill_no,
      account_id: labourBillCycles.account_id,
      status: labourBillCycles.status,
      required_touch: labourBillCycles.required_touch,
    })
    .from(labourBillCycles)
    .where(eq(labourBillCycles.id, cycleId))
    .limit(1);
  if (!cycle) {
    throw new AppError("NOT_FOUND", "Selected bill cycle does not exist.");
  }
  if (cycle.account_id !== accountId) {
    throw new AppError(
      "BUSINESS_RULE_VIOLATION",
      "Selected bill cycle belongs to a different goldsmith.",
    );
  }
  assertCycleTakesBills(cycle, existingCycleId, "labour bill", "bill_cycle_id");
  return cycle;
}

// ─── Labour Bill cycle / Required Touch rules ─────────────────────────────────

const PICK_CYCLE_MESSAGE = "Pick a cycle or New cycle.";
const TOUCH_NEEDED_MESSAGE = "Required Touch is needed when receiving gold.";

/** Required Touch from the bill form; "" / whitespace = not given. */
function givenRequiredTouch(touch: string | undefined): string | undefined {
  const t = touch?.trim();
  return t ? t : undefined;
}

/** A bill with any Gold Receipt row needs a touch: the form's, else the cycle's stored one. */
function assertTouchForGoldReceipt(
  goldReceiptRows: number,
  givenTouch: string | undefined,
  storedTouch: string | null | undefined,
) {
  if (goldReceiptRows > 0 && givenTouch === undefined && !storedTouch) {
    throw new AppError("VALIDATION_ERROR", TOUCH_NEEDED_MESSAGE, "required_touch");
  }
}

// ─── createLabourBill ─────────────────────────────────────────────────────────
// Cycle (exactly one of):
//  - bill_cycle_id → existing cycle of this customer; a NEW bill is refused on a
//    closed one (edits of a bill already on it stay allowed).
//  - new_cycle     → NEW bill only: the customer's next cycle (bill_no MAX+1,
//    main_reason null, OPEN) is created inside the bill's save transaction.
// Required Touch (rule: mandatory when the bill has a Gold Receipt row) is stored
// on a new cycle, or written to the existing cycle when it differs. close_cycle is
// applied last. Cycle insert, touch, bill, (edit: reversal of the old version) and
// close tick all commit or roll back together.

export async function createLabourBill(
  input: z.infer<typeof CreateLabourBillSchema>,
  options?: {
    existingBillNo?: number;
    existingEntryNo?: number;
    /** Edit: the cycle the stored bill is on — it may stay there even if DELIVERED. */
    existingCycleId?: string | null;
    /** Edit: the stored version, reversed inside the same save transaction.
     *  The reversal and the new version both take its created_at (backdated). */
    reverseGroupId?: string;
  }
) {
  // ── Always validate input regardless of call path (tRPC or direct) ──────────
  const validated = CreateLabourBillSchema.parse(input);

  const isEdit = options?.reverseGroupId !== undefined;
  const newCycle = validated.new_cycle === true;
  if (newCycle && isEdit) {
    throw new AppError(
      "VALIDATION_ERROR",
      "New cycle is only for a new bill — pick an existing cycle when editing.",
      "new_cycle",
    );
  }
  // ── Exactly one of bill_cycle_id / new_cycle ─────────────────────────────────
  // A labour bill must always live inside a real cycle (without one the entry
  // builder would auto-number a phantom bill_no that maps to no cycle).
  if (newCycle === !!validated.bill_cycle_id) {
    throw new AppError("VALIDATION_ERROR", PICK_CYCLE_MESSAGE, "bill_cycle_id");
  }

  const touch = givenRequiredTouch(validated.required_touch);
  // Pre-check (outside the transaction) so a refusal costs nothing; the locked
  // re-check below is what guards against a concurrent change.
  const precheckedCycle = validated.bill_cycle_id
    ? await assertLabourBillCycle(validated.bill_cycle_id, input.account_id, options?.existingCycleId)
    : null;
  assertTouchForGoldReceipt(validated.gold_receipt.length, touch, precheckedCycle?.required_touch);

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
  // KEY DESIGN (mirrors Ornament Receipt below): the PHYSICAL ornament weight is
  // what leaves the shop's stock — the wastage is an accounting charge against the
  // goldsmith's gold, not extra metal handed over. Previously `quantity` was the
  // wastage-inflated grossWeight, so issuing a 10.000g ornament at 2% wastage
  // removed 10.220g from stock even though only 10.000g physically left.
  // The goldsmith's pure balance is unchanged by this fix — it still carries the
  // full gross pure (wastage included) via the pureQuantity override.
  for (const item of input.ornament_issue) {
    const { grossWeight, pureQuantity: grossPure, wastageGm } = calcOrnamentEntry(item);

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
      // Physical weight only — this is what actually leaves the shop's stock lot.
      quantity: item.quantity,
      purity: item.purity,
      // Override: total pure gold the goldsmith is accountable for =
      // (physicalWeight + wastageGm) × touch%. Keeps the wastage on their gold
      // balance without inflating the stock movement above.
      pureQuantity: grossPure,
      wastageMode: "PERCENT",
      wastageValue: item.wastage_percent,
      // quantity is the physical base weight, so wastage_quantity must be passed
      // explicitly rather than recomputed off an already-inflated figure.
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

  // One transaction: (new cycle | locked existing cycle + touch), the edited
  // bill's reversal, the bill and the "Close cycle" tick commit or roll back
  // together. An existing cycle is locked and re-checked first; its status as
  // read here (BEFORE the tick) is what decides whether the bill may be saved.
  return db.transaction(async (tx) => {
    let cycle: { id: string; bill_no: number; status: string; required_touch: string | null };
    if (newCycle) {
      cycle = await insertNextCycle(tx, {
        account_id: input.account_id,
        main_reason: null,
        required_touch: touch === undefined ? null : toDecimal(touch).toDecimalPlaces(2).toFixed(2),
      });
    } else {
      cycle = await lockCycleForBill(tx, validated.bill_cycle_id!, options?.existingCycleId);
      assertTouchForGoldReceipt(validated.gold_receipt.length, touch, cycle.required_touch);
      await applyCycleRequiredTouch(tx, cycle, touch);
    }

    // Edit: any bill (not just the newest) can be edited. The reversal and the
    // new version both keep the original bill's created_at, so an older bill
    // stays in its place and every later bill's opening picks up the change.
    if (options?.reverseGroupId) {
      await reverseEntryGroup(options.reverseGroupId, tx, { backdate: true });
    }

    const { group, entries: created } = await createEntryGroup({
      type: "LABOUR_BILL",
      accountId: input.account_id,
      date: input.date,
      billNo: cycle.bill_no, // always the real cycle's bill_no
      entryNo: options?.existingEntryNo,
      ratePerGram: input.rate_per_gram,
      remarks: input.remarks,
      billCycleId: cycle.id,
      tdsAmount: input.tds_amount,
      tcsAmount: input.tcs_amount,
      // Edit: copy the stored version's timestamp (group + entries) — see above.
      createdAtFromGroupId: options?.reverseGroupId,
      entries,
    }, tx);

    await applyCycleCloseFlag(tx, cycle, validated.close_cycle);

    // The cycle as the bill left it (touch / close tick applied) — the UI
    // toasts "Saved on Cycle N" from this.
    const [saved] = await tx
      .select({
        id: labourBillCycles.id,
        bill_no: labourBillCycles.bill_no,
        required_touch: labourBillCycles.required_touch,
        status: labourBillCycles.status,
      })
      .from(labourBillCycles)
      .where(eq(labourBillCycles.id, cycle.id))
      .limit(1);
    if (!saved) throw new AppError("INTERNAL_ERROR", "Bill cycle vanished during save");

    return { group, entries: created, cycle: saved };
  });
}

// ─── updateLabourBill ─────────────────────────────────────────────────────────

export async function updateLabourBill(input: z.infer<typeof UpdateLabourBillSchema>) {
  // ── Always validate input regardless of call path (tRPC or direct) ──────────
  UpdateLabourBillSchema.parse(input);

  // An edited bill keeps / chooses an EXISTING cycle — "New cycle" is for new
  // bills only. Refused before anything is touched.
  if (input.new_cycle === true) {
    throw new AppError(
      "VALIDATION_ERROR",
      "New cycle is only for a new bill — pick an existing cycle when editing.",
      "new_cycle",
    );
  }
  if (!input.bill_cycle_id) {
    throw new AppError(
      "VALIDATION_ERROR",
      "A bill cycle must be selected before saving a labour bill.",
      "bill_cycle_id",
    );
  }

  const [originalGroup] = await db
    .select({
      bill_no: entryGroups.bill_no,
      entry_no: entryGroups.entry_no,
      bill_cycle_id: entryGroups.bill_cycle_id,
    })
    .from(entryGroups)
    .where(eq(entryGroups.id, input.id))
    .limit(1);

  if (!originalGroup) {
    throw new AppError("NOT_FOUND", "Labour bill not found");
  }

  // Any bill (not just the goldsmith's latest) can be edited. The reversal and
  // the new version both keep the original timestamp, so the bill stays in
  // place and every later bill's opening balance picks up the change
  // automatically. (Delete stays newest-only — see assertDeletableLastBill.)
  // The old version is reversed INSIDE createLabourBill's save transaction
  // (reverseGroupId), so any refusal — closed cycle, missing Required Touch, a
  // concurrent edit — leaves the stored bill untouched.
  const { id: _removed, new_cycle: _newCycle, ...createInput } = input;
  return createLabourBill(createInput, {
    existingBillNo: originalGroup.bill_no ?? undefined,
    existingEntryNo: originalGroup.entry_no ?? undefined,
    existingCycleId: originalGroup.bill_cycle_id,
    reverseGroupId: input.id,
  });
}

// ─── deleteLabourBill ─────────────────────────────────────────────────────────

export async function deleteLabourBill(input: z.infer<typeof DeleteTxSchema>) {
  // Only the party's most recent labour bill may go — see assertDeletableLastBill.
  await assertDeletableLastBill(input.id, "LABOUR_BILL");
  // Nothing is erased: the bill is reversed with an opposite entry group and then
  // marked deleted, so the ledger still shows what happened and when.
  await reverseEntryGroup(input.id);
  return { success: true, id: input.id };
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
