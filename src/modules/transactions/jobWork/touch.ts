import { AppError } from "@/types/errors";

// ─── Required Touch % (job-work Bill Cycle) ───────────────────────────────────
// Same rule as Labour Bill cycles: a job work with any Gold Receipt or Ornament
// Receipt row needs a touch — the bill form's, else the cycle's stored one.
// Receipts below the touch are never refused (frontend warning only).
// Pure helpers (no DB) so they can be unit-tested.

export const JOB_WORK_TOUCH_NEEDED_MESSAGE =
  "Required Touch % is needed when the bill has a Gold or Ornament Receipt.";

/** Required Touch from the bill / cycle form; undefined, "" or whitespace = not given. */
export function givenRequiredTouch(touch: string | undefined | null): string | undefined {
  const t = touch?.trim();
  return t ? t : undefined;
}

/** Throws when the bill has receipt rows and neither the form nor the cycle has a touch. */
export function assertTouchForReceipts(
  receiptRows: number,
  givenTouch: string | undefined,
  storedTouch: string | null | undefined,
) {
  if (receiptRows > 0 && givenTouch === undefined && !storedTouch) {
    throw new AppError("VALIDATION_ERROR", JOB_WORK_TOUCH_NEEDED_MESSAGE, "required_touch");
  }
}
