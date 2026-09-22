import { ZodError } from "zod";

/**
 * Turns a Zod validation failure into a sentence an operator can act on.
 *
 * Without this, tRPC puts the raw ZodError array into the error message and the
 * shop sees a wall of JSON — `[{"code":"too_big","maximum":10,...}]` — when all
 * they did was type an 11-character PAN. Here that becomes:
 *
 *   PAN: Must be at most 10 characters
 *
 * Only the first few problems are listed: a form with eight empty boxes should
 * not produce a paragraph.
 */

/** Field names the trade knows by another name than the column does. */
const FIELD_LABELS: Record<string, string> = {
  gst_no: "GSTIN",
  gstin: "GSTIN",
  pan_no: "PAN",
  pan_number: "PAN",
  ifsc_code: "IFSC code",
  hsn_code: "HSN / SAC",
  sac_code: "HSN / SAC",
  bill_no: "Bill no",
  entry_no: "Entry no",
  account_id: "Account",
  item_id: "Item",
  lot_id: "Lot",
  rate_per_gram: "Rate per gram",
  bill_cycle_id: "Bill cycle",
  bank_details: "Bank",
  tds_amount: "TDS amount",
  tcs_amount: "TCS amount",
  bill_gst_percent: "GST %",
  customer_type: "Category",
  state_code: "State code",
  place_of_supply: "Place of supply",
  bank_account_no: "Bank account no",
  from_account_id: "Paid from",
  piece_count: "Quantity",
  gst_percent: "GST %",
  purity: "Touch",
  quantity: "Weight",
  wastage_value: "Wastage",
};

function labelFor(path: readonly (string | number | symbol)[]): string {
  // The last named segment is the field; array indexes in between only say
  // "row 3", which the row number below already conveys.
  const named = path.filter((p): p is string => typeof p === "string");
  const field = named[named.length - 1];
  if (!field) return "";

  const label =
    FIELD_LABELS[field] ??
    field.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

  // Point at the row when the failure is inside a list of items.
  const index = path.find((p) => typeof p === "number");
  return typeof index === "number" ? `Row ${index + 1} ${label}` : label;
}

/**
 * Zod's own wording is written for developers. These are the phrases that reach
 * an operator most often, said plainly.
 */
function readableIssue(issue: { code: string; message: string; [k: string]: unknown }): string {
  const message = issue.message;

  if (/^Required$/i.test(message) || issue.code === "invalid_type") {
    if (String(issue.received) === "undefined" || String(issue.received) === "null") {
      return "Required";
    }
  }
  if (issue.code === "too_big" && typeof issue.maximum === "number") {
    return issue.origin === "string"
      ? `Must be at most ${issue.maximum} characters`
      : `Must not be more than ${issue.maximum}`;
  }
  if (issue.code === "too_small" && typeof issue.minimum === "number") {
    if (issue.origin === "string") {
      return issue.minimum === 1 ? "Required" : `Must be at least ${issue.minimum} characters`;
    }
    return `Must be at least ${issue.minimum}`;
  }
  if (issue.code === "invalid_format") {
    if (issue.format === "uuid") return "Please choose a valid option from the list";
    if (issue.format === "email") return "Enter a valid email address";
  }
  return message;
}

export function formatZodError(error: unknown): string | null {
  const zodError =
    error instanceof ZodError
      ? error
      : (error as { cause?: unknown })?.cause instanceof ZodError
        ? ((error as { cause: ZodError }).cause)
        : null;
  if (!zodError) return null;

  const seen = new Set<string>();
  const parts: string[] = [];
  for (const issue of zodError.issues) {
    const label = labelFor(issue.path);
    const text = readableIssue(issue as never);
    const line = label ? `${label}: ${text}` : text;
    if (seen.has(line)) continue;
    seen.add(line);
    parts.push(line);
  }

  if (parts.length === 0) return "Please check the values entered and try again.";

  const shown = parts.slice(0, 4);
  const rest = parts.length - shown.length;
  return shown.join("\n") + (rest > 0 ? `\n…and ${rest} more` : "");
}
