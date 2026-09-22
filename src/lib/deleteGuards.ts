import { and, desc, eq, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { entryGroups, gstPurchaseHistory, gstSalesHistory } from "@/db/schema";
import { AppError } from "@/types/errors";

/**
 * Guards a bill delete.
 *
 * A bill is only deletable while it is the LAST bill of its kind for that party.
 * Every figure a party sees — opening balance, running balance, the next bill's
 * own total — is built by walking their bills in order, so removing one from the
 * middle would silently rewrite every bill after it. Deleting from the end is the
 * only removal that leaves the rest of the history saying what it said before.
 *
 * The check lives here, not in the button, because the button is only a courtesy:
 * a stale page, a second browser tab or a direct API call must hit the same rule.
 */

type BillType = "PURCHASE" | "SALE" | "LABOUR_BILL" | "JOB_WORK";

const LABEL: Record<BillType, string> = {
  PURCHASE: "purchase",
  SALE: "sale",
  LABOUR_BILL: "labour bill",
  JOB_WORK: "job work",
};

export async function assertDeletableLastBill(groupId: string, type: BillType) {
  const [group] = await db
    .select()
    .from(entryGroups)
    .where(eq(entryGroups.id, groupId))
    .limit(1);

  if (!group) throw new AppError("NOT_FOUND", `This ${LABEL[type]} no longer exists.`);
  if (group.type !== type) {
    throw new AppError("VALIDATION_ERROR", `This entry is not a ${LABEL[type]}.`);
  }
  if (group.is_deleted) {
    throw new AppError("BUSINESS_RULE_VIOLATION", `This ${LABEL[type]} is already deleted.`);
  }

  // Converting a bill to GST copies it into the GST history; deleting the bill
  // underneath would leave that copy pointing at nothing. Undo the conversion
  // first — that path already knows how to unpick it.
  const converted =
    type === "PURCHASE"
      ? await db
          .select({ id: gstPurchaseHistory.id })
          .from(gstPurchaseHistory)
          .where(eq(gstPurchaseHistory.purchase_id, groupId))
          .limit(1)
      : type === "SALE"
        ? await db
            .select({ id: gstSalesHistory.id })
            .from(gstSalesHistory)
            .where(eq(gstSalesHistory.sale_id, groupId))
            .limit(1)
        : [];
  if (converted.length > 0) {
    throw new AppError(
      "BUSINESS_RULE_VIOLATION",
      `This ${LABEL[type]} has been converted to GST. Undo the GST conversion first, then delete it.`,
    );
  }

  // The party's newest bill of this kind. Conversion entries carry no bill_no and
  // are bookkeeping, not bills, so they never stand in the way of a delete.
  const [latest] = await db
    .select({ id: entryGroups.id })
    .from(entryGroups)
    .where(
      and(
        eq(entryGroups.type, type),
        eq(entryGroups.account_id, group.account_id),
        eq(entryGroups.is_deleted, false),
        or(isNull(entryGroups.reversal_of), eq(entryGroups.id, groupId)),
      ),
    )
    .orderBy(desc(entryGroups.bill_no), desc(entryGroups.created_at))
    .limit(1);

  if (latest && latest.id !== groupId) {
    throw new AppError(
      "BUSINESS_RULE_VIOLATION",
      `Only this party's most recent ${LABEL[type]} can be deleted. Delete the later ${LABEL[type]}s first.`,
    );
  }

  return group;
}
