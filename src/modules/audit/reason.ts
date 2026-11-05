// ─── "Why are you changing this bill?" ────────────────────────────────────────
// Editing / deleting / undoing a saved bill or voucher — and recording a
// payment on one — needs a reason. The
// frontend sends it (encodeURIComponent'd) in the x-audit-reason header of that
// one mutation request; src/lib/context.ts decodes it into ctx.auditReason and
// protectedProcedure (src/lib/trpc.ts) refuses a matching mutation without one.
// Pure — no database / env imports.
//
// Ported from Gold CRM. GST CRM has no investment / order voucher / wages
// routers, so those paths are gone. Melting (GST CRM only) does NOT need a reason — owner decision 2026-11-05.
// The frontend mirrors this rule (gstcrm_frontend/src/lib/auditReason.ts).

export const AUDIT_REASON_HEADER = "x-audit-reason";
export const AUDIT_REASON_MIN = 3;
export const AUDIT_REASON_MAX = 500;
export const AUDIT_REASON_REQUIRED_MESSAGE = "Please give a reason for this change.";

/** transactions.<any>.update* / delete* / undo*, and the same under bank, stock. Melting is deliberately NOT included (owner decision 2026-11-05). */
export const AUDIT_REASON_PATH_RE =
  /^(transactions\.[a-zA-Z]+|bank|stock)\.(update\w*|delete\w*|undo\w*)$/;

/**
 * Payment actions on an already-saved bill (owner's rule). Exact paths only.
 * The standalone account-level actions (labourBill / jobWork receiveCash,
 * convertGoldToCash, convertCashToGold) create new records and are
 * deliberately NOT here.
 */
export const AUDIT_REASON_EXTRA_PATHS: ReadonlySet<string> = new Set([
  "transactions.purchase.settlePayment",
  "transactions.sales.settlePayment",
]);

/** True when this tRPC procedure path changes or removes a saved bill / voucher. */
export function requiresAuditReason(path: string): boolean {
  return AUDIT_REASON_PATH_RE.test(path) || AUDIT_REASON_EXTRA_PATHS.has(path);
}

// Control characters (keep \t \n \r) — Postgres text cannot hold NUL at all.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * Header value → reason text, or null when missing / undecodable / outside
 * 3–500 characters after decoding and trimming.
 */
export function parseAuditReasonHeader(raw: string | string[] | undefined | null): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || value === "") return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  const reason = decoded.replace(CONTROL_CHARS, "").trim();
  if (reason.length < AUDIT_REASON_MIN || reason.length > AUDIT_REASON_MAX) return null;
  return reason;
}
