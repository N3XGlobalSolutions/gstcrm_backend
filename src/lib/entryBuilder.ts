import { db } from "@/db";
import {
  entries,
  entryGroups,
  items as itemsTable,
  accounts as accountsTable,
  type wastageModeEnum,
} from "@/db/schema";
import { inArray } from "drizzle-orm";
import {
  calcPure,
  calcWastagePercent,
  calcWastageGram,
  toQuantityString,
  toAmountString,
  toDecimal,
} from "./decimal";
import { generateEntryGroupNo, generateLotId, generateLotIds } from "./entryNoGenerator";
import { generateBillNo } from "./transactionQueries";

// ─── Types ────────────────────────────────────────────────────────────────────

type EntryGroupType =
  | "PURCHASE"
  | "SALE"
  | "JOB_WORK"
  | "LABOUR_BILL"
  | "EXPENSE"
  | "OPENING"
  | "REVERSAL";

type WastageMode = "PERCENT" | "GRAM";

export interface EntryInput {
  fromAccountId: string;
  toAccountId: string;
  itemId: string;
  quantity: string; // decimal string
  purity?: string; // touch percentage, decimal string
  pureQuantity?: string; // direct pure_quantity override (used for opening balances)
  wastageMode?: WastageMode;
  wastageValue?: string; // decimal string
  wastageQuantity?: string; // direct wastage_quantity override — required whenever `quantity` is
  // NOT the base weight the wastage % should be applied to (e.g. quantity is already the
  // gross/wastage-inflated weight). Without this, recomputing from wastageMode/wastageValue
  // would apply the wastage % on top of the already-inflated quantity.
  rate?: string; // decimal string
  amount?: string; // decimal string
  remarks?: string;
  lotId?: string; // Optional lot_id specifically for OUT items to track consumption
}

export interface CreateEntryGroupInput {
  type: EntryGroupType;
  accountId: string;
  date: string; // ISO YYYY-MM-DD
  entryNo?: number;
  billNo?: number;
  // Gold/cash conversion entries are bookkeeping adjustments, not real bills — they
  // must not consume a slot in the account's bill number sequence (which would leave
  // a confusing gap in the printed bill numbering for real sales/purchases).
  skipBillNo?: boolean;
  billCycleId?: string;  // FK to labour_bill_cycles.id
  jobWorkCycleId?: string;  // FK to job_work_cycles.id
  ratePerGram?: string;
  remarks?: string;
  reversalOf?: string;
  tdsAmount?: string;
  tcsAmount?: string;
  gstAmount?: string;
  entries: EntryInput[];
}

// ─── createEntryGroup ─────────────────────────────────────────────────────────

/**
 * The ONLY function that writes to the ledger.
 * Every write path in the system calls this function.
 * All operations run inside a single PostgreSQL transaction — any failure rolls back everything.
 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Optional: pass the caller's Drizzle transaction so SELECT FOR UPDATE locks
 * acquired before this call remain held until the inserts complete.
 * When omitted, starts its own transaction.
 */
export async function createEntryGroup(input: CreateEntryGroupInput, externalTx?: Tx) {
  const run = async (tx: Tx) => {
    // Step 1 — Generate entry_no for the group (REVERSAL entries don't get a visible number)
    const groupEntryNo = input.entryNo ?? (input.type !== "REVERSAL"
      ? await generateEntryGroupNo(tx, input.type)
      : undefined);

    // Step 1.5 — Generate bill_no if not provided and not REVERSAL or OPENING
    let groupBillNo = input.billNo;
    if (
      groupBillNo === undefined &&
      input.type !== "REVERSAL" &&
      input.type !== "OPENING" &&
      !input.skipBillNo
    ) {
      groupBillNo = await generateBillNo(tx, input.accountId, input.type);
    }

    // Step 2 — Insert the entry_group row
    const [group] = await tx
      .insert(entryGroups)
      .values({
        entry_no: groupEntryNo,
        date: input.date,
        type: input.type,
        account_id: input.accountId,
        bill_no: groupBillNo,
        bill_cycle_id: input.billCycleId ?? null,
        job_work_cycle_id: input.jobWorkCycleId ?? null,
        rate_per_gram: input.ratePerGram,
        remarks: input.remarks,
        reversal_of: input.reversalOf,
        tds_amount: input.tdsAmount,
        tcs_amount: input.tcsAmount,
        gst_amount: input.gstAmount,
      })
      .returning();

    if (!group) throw new Error("Failed to insert entry_group");

    // Fetch types to determine if we need to auto-generate lot_ids
    const itemIds = [...new Set(input.entries.map((e) => e.itemId))];
    const toAccountIds = [...new Set(input.entries.map((e) => e.toAccountId))];

    const [itemTypes, accountTypes] = await Promise.all([
      tx.select({ id: itemsTable.id, type: itemsTable.type }).from(itemsTable).where(inArray(itemsTable.id, itemIds)),
      tx.select({ id: accountsTable.id, type: accountsTable.type, customer_type: accountsTable.customer_type }).from(accountsTable).where(inArray(accountsTable.id, toAccountIds)),
    ]);

    const itemTypeMap = new Map(itemTypes.map((i) => [i.id, i.type]));
    const accountTypeMap = new Map(accountTypes.map((a) => [a.id, a]));

    // Step 2.5 - Pre-calculate lot IDs to avoid sequential round-trips
    let neededLotIdsCount = 0;
    for (const entry of input.entries) {
      if (!entry.lotId) {
        const itemType = itemTypeMap.get(entry.itemId);
        const toAccount = accountTypeMap.get(entry.toAccountId);
        const toAccountType = toAccount?.type;
        const toCustomerType = toAccount?.customer_type;
        if (
          itemType === "ORNAMENT" &&
          (
            toAccountType === "SHOP" ||
            toAccountType === "GOLDSMITH" ||
            (toAccountType === "CUSTOMER" && toCustomerType === "GOLD_SMITH")
          )
        ) {
          neededLotIdsCount++;
        }
      }
    }

    const generatedLotIds = await generateLotIds(tx, neededLotIdsCount);
    let lotIdIdx = 0;

    // Step 3 — Build and insert entries as a single batch
    const entriesToInsert = [];
    for (const entry of input.entries) {
      // Compute pure_quantity from purity, or use direct override if provided
      // NOTE: must check !== undefined, NOT truthiness — "0" is a valid override
      // (used by cash-mode purchases to suppress pure balance accumulation)
      let pureQuantity: string | undefined;
      if (entry.pureQuantity !== undefined) {
        pureQuantity = entry.pureQuantity;
      } else if (entry.purity) {
        pureQuantity = toQuantityString(calcPure(entry.quantity, entry.purity));
      }

      // Compute wastage_quantity from mode, or use direct override if provided
      let wastageQuantity: string | undefined;
      if (entry.wastageQuantity !== undefined) {
        wastageQuantity = entry.wastageQuantity;
      } else if (entry.wastageMode && entry.wastageValue) {
        if (entry.wastageMode === "PERCENT" && entry.purity) {
          wastageQuantity = toQuantityString(
            calcWastagePercent(entry.quantity, entry.wastageValue, entry.purity),
          );
        } else if (entry.wastageMode === "GRAM") {
          wastageQuantity = toQuantityString(
            calcWastageGram(entry.quantity, entry.wastageValue),
          );
        }
      }

      // Compute average touch for the entry
      let averageTouch: string | undefined;
      if (pureQuantity && entry.quantity) {
        const qty = toDecimal(entry.quantity);
        const wQty = wastageQuantity ? toDecimal(wastageQuantity) : toDecimal("0");
        const origWeight = qty.minus(wQty);
        if (origWeight.gt(0)) {
          averageTouch = toQuantityString(toDecimal(pureQuantity).div(origWeight).mul(100));
        }
      }

      // Generate or assign lotId
      let finalLotId = entry.lotId;
      if (!finalLotId) {
        const itemType = itemTypeMap.get(entry.itemId);
        const toAccount = accountTypeMap.get(entry.toAccountId);
        const toAccountType = toAccount?.type;
        const toCustomerType = toAccount?.customer_type;
        if (
          itemType === "ORNAMENT" &&
          (
            toAccountType === "SHOP" ||
            toAccountType === "GOLDSMITH" ||
            (toAccountType === "CUSTOMER" && toCustomerType === "GOLD_SMITH")
          )
        ) {
          finalLotId = generatedLotIds[lotIdIdx++];
        }
      }

      entriesToInsert.push({
        group_id: group.id,
        lot_id: finalLotId,
        from_account_id: entry.fromAccountId,
        to_account_id: entry.toAccountId,
        item_id: entry.itemId,
        quantity: entry.quantity,
        purity: entry.purity,
        pure_quantity: pureQuantity,
        wastage_mode: entry.wastageMode as
          | (typeof wastageModeEnum.enumValues)[number]
          | undefined,
        wastage_value: entry.wastageValue,
        wastage_quantity: wastageQuantity,
        rate: entry.rate,
        amount: entry.amount,
        average_touch: averageTouch,
        remarks: entry.remarks,
      });
    }

    let insertedEntries: any[] = [];
    if (entriesToInsert.length > 0) {
      insertedEntries = await tx.insert(entries).values(entriesToInsert).returning();
      if (insertedEntries.length !== entriesToInsert.length) {
        throw new Error("Failed to insert all entries");
      }
    }

    return { group, entries: insertedEntries };
  };

  return externalTx ? run(externalTx) : db.transaction(run);
}
