/**
 * fixAverageTouch.ts
 *
 * Backfill script: recomputes `average_touch` for all ORNAMENT entries belonging
 * to LABOUR_BILL or JOB_WORK groups where `wastage_quantity IS NOT NULL`.
 *
 * WHY:
 *   entryBuilder.ts previously used: avgT = pure_quantity / (quantity - wastage_quantity) × 100
 *   For the labour-bill / job-work "override path", quantity = physical base weight (NOT gross).
 *   Subtracting wastage_quantity from an already-base quantity gave a wrong (too-small)
 *   denominator, inflating average_touch above the real touch %.
 *
 * CORRECT formula (matches UI exactly):
 *   average_touch = pure_quantity / quantity × 100
 *   (quantity is the physical base weight; pure_quantity already encodes the wastage via the override)
 *
 * SCOPE:
 *   Only ORNAMENT entries from LABOUR_BILL / JOB_WORK groups with wastage_quantity set.
 *   PURCHASE/SALE entries are unaffected — their quantity IS the gross (base+wastage) weight
 *   so the old formula was correct for them.
 *
 * SAFETY:
 *   average_touch is a display/reporting field only. It does NOT affect gold balances,
 *   cash balances, or stock movements. Updating it is safe.
 *   The script is idempotent: re-running it on already-fixed rows produces the same value.
 */

import { db } from "@/db";
import {
  entries,
  entryGroups,
  items as itemsTable,
} from "@/db/schema";
import { eq, inArray, isNotNull, and } from "drizzle-orm";

function safeDiv(a: string, b: string): string | null {
  const numA = parseFloat(a);
  const numB = parseFloat(b);
  if (!isFinite(numA) || !isFinite(numB) || numB <= 0) return null;
  return ((numA / numB) * 100).toFixed(8);
}

async function main() {
  console.log("=== fixAverageTouch: starting ===\n");

  // 1. Collect all LABOUR_BILL and JOB_WORK group IDs (not deleted, not reversals)
  const relevantGroups = await db
    .select({ id: entryGroups.id, type: entryGroups.type })
    .from(entryGroups)
    .where(
      and(
        inArray(entryGroups.type, ["LABOUR_BILL", "JOB_WORK"]),
        eq(entryGroups.is_deleted, false),
      )
    );

  if (relevantGroups.length === 0) {
    console.log("No LABOUR_BILL or JOB_WORK groups found. Nothing to fix.");
    process.exit(0);
  }

  const groupIds = relevantGroups.map((g) => g.id);
  console.log(`Found ${relevantGroups.length} relevant entry groups.`);

  // 2. Fetch ORNAMENT entries in those groups where wastage_quantity IS NOT NULL
  //    (these are the "override path" entries that were stored with the wrong avgT)
  const candidateEntries = await db
    .select({
      id: entries.id,
      quantity: entries.quantity,
      pure_quantity: entries.pure_quantity,
      wastage_quantity: entries.wastage_quantity,
      average_touch: entries.average_touch,
      item_id: entries.item_id,
    })
    .from(entries)
    .where(
      and(
        inArray(entries.group_id, groupIds),
        isNotNull(entries.wastage_quantity),
        isNotNull(entries.pure_quantity),
      )
    );

  if (candidateEntries.length === 0) {
    console.log("No candidate entries with wastage_quantity found. Nothing to fix.");
    process.exit(0);
  }

  // 3. Filter to ORNAMENT item type only
  const itemIds = [...new Set(candidateEntries.map((e) => e.item_id))];
  const itemTypeRows = await db
    .select({ id: itemsTable.id, type: itemsTable.type })
    .from(itemsTable)
    .where(inArray(itemsTable.id, itemIds));

  const itemTypeMap = new Map(itemTypeRows.map((i) => [i.id, i.type]));

  const toFix = candidateEntries.filter(
    (e) => itemTypeMap.get(e.item_id) === "ORNAMENT"
  );

  console.log(`Found ${toFix.length} ORNAMENT entries to recompute average_touch.\n`);

  if (toFix.length === 0) {
    console.log("Nothing to fix.");
    process.exit(0);
  }

  // 4. Recompute and update each entry
  let fixed = 0;
  let skipped = 0;
  let errors = 0;

  for (const entry of toFix) {
    if (!entry.pure_quantity || !entry.quantity) {
      console.warn(`  SKIP entry ${entry.id}: missing pure_quantity or quantity`);
      skipped++;
      continue;
    }

    // Frontend formula: averageT = pure_quantity / quantity × 100
    const newAvgTouch = safeDiv(entry.pure_quantity, entry.quantity);

    if (newAvgTouch === null) {
      console.warn(`  SKIP entry ${entry.id}: division resulted in invalid value`);
      skipped++;
      continue;
    }

    const oldAvgTouch = entry.average_touch ?? "(null)";
    const changed = oldAvgTouch !== newAvgTouch;

    try {
      await db
        .update(entries)
        .set({ average_touch: newAvgTouch })
        .where(eq(entries.id, entry.id));

      console.log(
        `  [${changed ? "FIXED" : "same "}] entry ${entry.id}` +
        `  qty=${entry.quantity}  pure=${entry.pure_quantity}` +
        `  old_avgT=${oldAvgTouch}  new_avgT=${newAvgTouch}`
      );
      fixed++;
    } catch (err) {
      console.error(`  ERROR updating entry ${entry.id}:`, err);
      errors++;
    }
  }

  console.log(`\n=== Done ===`);
  console.log(`  Fixed  : ${fixed}`);
  console.log(`  Skipped: ${skipped}`);
  console.log(`  Errors : ${errors}`);

  process.exit(errors > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
