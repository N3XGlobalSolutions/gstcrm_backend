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
