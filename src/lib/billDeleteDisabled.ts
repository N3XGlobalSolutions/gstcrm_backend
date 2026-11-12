import { TRPCError } from "@trpc/server";

/**
 * Owner's rule (2026-11-12, GST CRM only): bills are never deleted on Sales,
 * Purchase, Labour Bill or Issue & Job Works — a wrong bill is corrected with
 * Edit. The `delete` routes stay (so old clients get a clear message instead of
 * "No procedure found") but always refuse. The delete* service functions are
 * kept for the full-cycle tests and are not reachable from the API.
 */
export const BILL_DELETE_DISABLED_MESSAGE =
  "Deleting bills is turned off. Open the bill and use Edit to correct it.";

export function billDeleteDisabled(): never {
  throw new TRPCError({ code: "FORBIDDEN", message: BILL_DELETE_DISABLED_MESSAGE });
}

/**
 * Same rule for the Stock page: deleting a lot reversed the whole bill that
 * created it (Purchase / Labour Bill / Job Work / opening stock), so
 * `stock.deleteByLot` always refuses too.
 */
export const STOCK_LOT_DELETE_DISABLED_MESSAGE =
  "Deleting stock lots is turned off — a lot belongs to a bill. Open that bill and use Edit to correct it.";

export function stockLotDeleteDisabled(): never {
  throw new TRPCError({ code: "FORBIDDEN", message: STOCK_LOT_DELETE_DISABLED_MESSAGE });
}
