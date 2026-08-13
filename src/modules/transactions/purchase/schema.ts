import { z } from "zod";

// ─── Shared list schema ───────────────────────────────────────────────────────

export const ListTxSchema = z.object({
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
  from_date: z.string().optional(),
  to_date: z.string().optional(),
});

export const GetByIdSchema = z.object({ id: z.string().uuid() });
export const DeleteTxSchema = z.object({ id: z.string().uuid() });

// ─── Purchase schemas ─────────────────────────────────────────────────────────

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format, expected YYYY-MM-DD");
const positiveDecimalSchema = z.string().refine(v => !isNaN(parseFloat(v)) && parseFloat(v) > 0, "Must be greater than zero");
const nonNegativeDecimalSchema = z.string().refine(v => !isNaN(parseFloat(v)) && parseFloat(v) >= 0, "Must be non-negative");
const puritySchema = z.string().refine(v => {
  const p = parseFloat(v);
  return !isNaN(p) && p > 0 && p <= 100;
}, "Purity must be between 0.01% and 100%");

const PurchaseItemSchema = z.object({
  item_id: z.string().uuid(),
  quantity: positiveDecimalSchema,
  purity: puritySchema,
  rate: positiveDecimalSchema.optional(),
});

export const CreatePurchaseSchema = z.object({
  account_id: z.string().uuid(),
  date: dateSchema,
  rate_per_gram: positiveDecimalSchema,
  remarks: z.string().optional(),
  gold_items: z.array(PurchaseItemSchema).default([]),
  ornament_items: z.array(PurchaseItemSchema).default([]),
  bank_amount: nonNegativeDecimalSchema.default("0"),
  bank_details: z.string().optional(),
  discount: nonNegativeDecimalSchema.optional(),
  discount_pure: nonNegativeDecimalSchema.optional(),
  balance_mode: z.enum(['PURE', 'CASH']).default('PURE'),
  // TDS/TCS — tax withholding adjustments that affect the running balance,
  // same as Sales.
  tds_enabled: z.boolean().default(false),
  tds_amount: nonNegativeDecimalSchema.default('0'),
  tcs_enabled: z.boolean().default(false),
  tcs_amount: nonNegativeDecimalSchema.default('0'),
});

export const UpdatePurchaseSchema = CreatePurchaseSchema.extend({
  id: z.string().uuid(),
});

// ─── Gold-to-Cash conversion ──────────────────────────────────────────────────
// Converts part of a purchaser's outstanding pure-gold balance into a cash debt,
// at an agreed rate. Purely a ledger reclassification — no items/stock involved.
// cash_amount is NOT accepted from the client — the two typed values (grams,
// rate) are the only source of truth, and the server derives cash_amount from
// them. Accepting a client-computed cash_amount and cross-checking it against a
// fixed tolerance broke in production: the frontend rounds gold_grams to 3dp
// for display, and at some rates that rounding alone exceeds any small fixed
// tolerance (e.g. 2.467g × ₹15,000 is ₹5 off from an unrounded ₹37,000 cash
// figure) — rejecting a perfectly valid conversion.
export const ConvertGoldToCashSchema = z.object({
  account_id: z.string().uuid(),
  gold_grams: positiveDecimalSchema,      // pure gold grams being converted — must be > 0
  rate_per_gram: positiveDecimalSchema,   // rate applied — must be > 0
});

// ─── Cash-to-Gold conversion ──────────────────────────────────────────────────
// The opposite of the above: converts part of a purchaser's outstanding cash
// debt into a pure-gold debt, at an agreed rate. gold_grams is derived
// server-side from cash_amount ÷ rate_per_gram — see note above.
export const ConvertCashToGoldSchema = z.object({
  account_id: z.string().uuid(),
  cash_amount: positiveDecimalSchema,     // cash being converted — must be > 0
  rate_per_gram: positiveDecimalSchema,   // rate applied — must be > 0
});

// ─── Settle payment against an existing bill ──────────────────────────────────
// Records an additional cash/bank payment against a specific purchase bill
// (a red "partially paid" row in Purchase History) without editing the bill
// itself. Validated server-side against that bill's own remaining balance —
// see settlePurchasePayment in service.ts.
export const SettlePurchasePaymentSchema = z.object({
  id: z.string().uuid(),
  amount: positiveDecimalSchema,
  method: z.enum(['CASH', 'BANK']),
  bank_details: z.string().optional(),
});

export const UpdateGSTPurchaseConversionSchema = z.object({
  id: z.string().uuid(),
  gst_amount: nonNegativeDecimalSchema,
  tds_amount: nonNegativeDecimalSchema,
  tcs_amount: nonNegativeDecimalSchema,
  // Full conversion-form snapshot (JSON string) — the printed GST bill reads this
  // back as its source of truth instead of recalculating from the ledger, so it
  // always matches exactly what was confirmed on the conversion popup.
  details: z.string().optional(),
});

