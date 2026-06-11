import { db } from "@/db";
import { entries, entryGroups } from "@/db/schema";
import { eq } from "drizzle-orm";
import { AppError } from "@/types/errors";
import { createEntryGroup } from "./entryBuilder";

/**
 * Reverse a completed entry group.
 *
 * Steps (all inside one DB transaction):
 *  1. Fetch the original entry_group row
 *  2. Guard: if reversed_by is already set → throw CONFLICT
 *  3. Fetch all child entries for that group
 *  4. Call createEntryGroup with type=REVERSAL, swapping from/to on each entry
 *  5. Set original group's reversed_by = new group's id
 *  6. Soft-delete the original entry_group (is_deleted = true)
 *
 * @param originalGroupId - UUID of the entry_group to reverse
 */
export async function reverseEntryGroup(originalGroupId: string) {
  return db.transaction(async (tx) => {
    // Step 1 — Fetch original group
    const [original] = await tx
      .select()
      .from(entryGroups)
      .where(eq(entryGroups.id, originalGroupId))
      .limit(1);

    if (!original) {
      throw new AppError("NOT_FOUND", "Entry group not found");
    }

    // Step 2 — Guard: already reversed?
    if (original.reversed_by) {
      throw new AppError("CONFLICT", "Transaction already reversed");
    }

    // Step 3 — Fetch all child entries
    const originalEntries = await tx
      .select()
      .from(entries)
      .where(eq(entries.group_id, originalGroupId));

    if (originalEntries.length === 0) {
      throw new AppError("NOT_FOUND", "No entries found for this group");
    }

    // Step 4 — Create reversal group (swap from/to on each entry, preserve lot_id)
    const { group: reversalGroup } = await createEntryGroup({
      type: "REVERSAL",
      accountId: original.account_id,
      date: original.date,
      ratePerGram: original.rate_per_gram ?? undefined,
      reversalOf: originalGroupId,
      remarks: original.remarks ?? undefined,
      entries: originalEntries.map((e) => ({
        fromAccountId: e.to_account_id, // swapped
        toAccountId: e.from_account_id, // swapped
        itemId: e.item_id,
        quantity: e.quantity,
        purity: e.purity ?? undefined,
        lotId: e.lot_id ?? undefined, // preserve lot_id so stock balances cancel out
        wastageMode: e.wastage_mode as "PERCENT" | "GRAM" | undefined,
        wastageValue: e.wastage_value ?? undefined,
        rate: e.rate ?? undefined,
        amount: e.amount ?? undefined,
        remarks: e.remarks ?? undefined,
      })),
    });

    // Step 5 — Mark original as reversed
    await tx
      .update(entryGroups)
      .set({ reversed_by: reversalGroup.id, updated_at: new Date() })
      .where(eq(entryGroups.id, originalGroupId));

    // Step 6 — Soft-delete the original
    await tx
      .update(entryGroups)
      .set({ is_deleted: true, updated_at: new Date() })
      .where(eq(entryGroups.id, originalGroupId));

    return reversalGroup;
  });
}
