import { z } from "zod";

// ─── Sales schemas ────────────────────────────────────────────────────────────

export const ListTxSchema = z.object({
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
  from_date: z.string().optional(),
  to_date: z.string().optional(),
  is_converted: z.boolean().optional(),
});

export const GetByIdSchema = z.object({ id: z.string().uuid() });
export const DeleteTxSchema = z.object({ id: z.string().uuid() });

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format, expected YYYY-MM-DD");
const positiveDecimalSchema = z.string().refine(v => !isNaN(parseFloat(v)) && parseFloat(v) > 0, "Must be greater than zero");
const nonNegativeDecimalSchema = z.string().refine(v => !isNaN(parseFloat(v)) && parseFloat(v) >= 0, "Must be non-negative");
const puritySchema = z.string().refine(v => {
  const p = parseFloat(v);
  return !isNaN(p) && p > 0 && p <= 100;
}, "Purity must be between 0.01% and 100%");

const SalesItemSchema = z.object({
  item_id: z.string().uuid(),
  lot_id: z.string().optional(),
  quantity: positiveDecimalSchema,
  purity: puritySchema,
  wastage_mode: z.enum(["PERCENT", "GRAM"]),
  wastage_value: nonNegativeDecimalSchema,
}).superRefine((val, ctx) => {
  // When PERCENT mode: value must be between 0 and 100 (inclusive)
  if (val.wastage_mode === "PERCENT") {
    const w = parseFloat(val.wastage_value);
    if (isNaN(w) || w < 0 || w > 100) {
      ctx.addIssue({
        code: "custom",
        path: ["wastage_value"],
        message: "Wastage percentage must be between 0% and 100%",
      });
    }
  }
});

export const CreateSalesSchema = z.object({
  account_id: z.string().uuid(),
  date: dateSchema,
  rate_per_gram: positiveDecimalSchema,
  remarks: z.string().optional(),
  items: z.array(SalesItemSchema).min(1),
  bank_amount: nonNegativeDecimalSchema.default('0'),
  bank_details: z.string().optional(),
  // Discount fields — applied to reduce customer balance in the ledger.
  discount: nonNegativeDecimalSchema.default('0'),
  discount_pure: nonNegativeDecimalSchema.default('0'),
  balance_mode: z.enum(['PURE', 'CASH']).default('PURE'),
  rate_for_balance: z.string().optional(),
  // TDS/TCS — tax withholding adjustments that affect the running balance.
  tds_enabled: z.boolean().default(false),
  tds_amount: nonNegativeDecimalSchema.default('0'),
  tcs_enabled: z.boolean().default(false),
  tcs_amount: nonNegativeDecimalSchema.default('0'),
});

export const UpdateSalesSchema = CreateSalesSchema.extend({
  id: z.string().uuid(),
});

// ─── Gold-to-Cash / Cash-to-Gold conversion ──────────────────────────────────
// Converts part of a customer's outstanding pure-gold balance into a cash debt
// (or vice versa), at an agreed rate. Purely a ledger reclassification — no
// items/stock involved.
export const ConvertGoldToCashSchema = z.object({
  account_id: z.string().uuid(),
  gold_grams: positiveDecimalSchema,      // pure gold grams being converted — must be > 0
  rate_per_gram: positiveDecimalSchema,   // rate applied — must be > 0
  cash_amount: positiveDecimalSchema,     // = gold_grams × rate_per_gram (pre-computed by frontend)
}).refine(
  d => Math.abs(parseFloat(d.gold_grams) * parseFloat(d.rate_per_gram) - parseFloat(d.cash_amount)) < 0.01,
  { message: "cash_amount must equal gold_grams × rate_per_gram (within ₹0.01 tolerance)", path: ["cash_amount"] }
);

export const ConvertCashToGoldSchema = z.object({
  account_id: z.string().uuid(),
  cash_amount: positiveDecimalSchema,     // cash being converted — must be > 0
  rate_per_gram: positiveDecimalSchema,   // rate applied — must be > 0
  gold_grams: positiveDecimalSchema,      // = cash_amount / rate_per_gram (pre-computed by frontend)
}).refine(
  d => Math.abs(parseFloat(d.cash_amount) - parseFloat(d.gold_grams) * parseFloat(d.rate_per_gram)) < 0.01,
  { message: "cash_amount must equal gold_grams × rate_per_gram (within ₹0.01 tolerance)", path: ["gold_grams"] }
);

export const UpdateGSTConversionSchema = z.object({
  id: z.string().uuid(),
  gst_amount: nonNegativeDecimalSchema,
  tds_amount: nonNegativeDecimalSchema,
  tcs_amount: nonNegativeDecimalSchema,
});
