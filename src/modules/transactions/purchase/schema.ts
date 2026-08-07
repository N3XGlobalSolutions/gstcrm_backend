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
});

export const UpdatePurchaseSchema = CreatePurchaseSchema.extend({
  id: z.string().uuid(),
});

// ─── Gold-to-Cash conversion ──────────────────────────────────────────────────
// Converts part of a purchaser's outstanding pure-gold balance into a cash debt,
// at an agreed rate. Purely a ledger reclassification — no items/stock involved.
export const ConvertGoldToCashSchema = z.object({
  account_id: z.string().uuid(),
  gold_grams: positiveDecimalSchema,      // pure gold grams being converted — must be > 0
  rate_per_gram: positiveDecimalSchema,   // rate applied — must be > 0
  cash_amount: positiveDecimalSchema,     // = gold_grams × rate_per_gram (pre-computed by frontend)
}).refine(
  d => Math.abs(parseFloat(d.gold_grams) * parseFloat(d.rate_per_gram) - parseFloat(d.cash_amount)) < 0.01,
  { message: "cash_amount must equal gold_grams × rate_per_gram (within ₹0.01 tolerance)", path: ["cash_amount"] }
);

// ─── Cash-to-Gold conversion ──────────────────────────────────────────────────
// The opposite of the above: converts part of a purchaser's outstanding cash
// debt into a pure-gold debt, at an agreed rate.
export const ConvertCashToGoldSchema = z.object({
  account_id: z.string().uuid(),
  cash_amount: positiveDecimalSchema,     // cash being converted — must be > 0
  rate_per_gram: positiveDecimalSchema,   // rate applied — must be > 0
  gold_grams: positiveDecimalSchema,      // = cash_amount / rate_per_gram (pre-computed by frontend)
}).refine(
  d => Math.abs(parseFloat(d.cash_amount) - parseFloat(d.gold_grams) * parseFloat(d.rate_per_gram)) < 0.01,
  { message: "cash_amount must equal gold_grams × rate_per_gram (within ₹0.01 tolerance)", path: ["gold_grams"] }
);

export const UpdateGSTPurchaseConversionSchema = z.object({
  id: z.string().uuid(),
  gst_amount: nonNegativeDecimalSchema,
  tds_amount: nonNegativeDecimalSchema,
  tcs_amount: nonNegativeDecimalSchema,
});

