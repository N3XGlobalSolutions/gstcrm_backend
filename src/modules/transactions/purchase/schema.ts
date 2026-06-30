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
});

export const UpdatePurchaseSchema = CreatePurchaseSchema.extend({
  id: z.string().uuid(),
});

export const UpdateGSTPurchaseConversionSchema = z.object({
  id: z.string().uuid(),
  gst_amount: nonNegativeDecimalSchema,
  tds_amount: nonNegativeDecimalSchema,
  tcs_amount: nonNegativeDecimalSchema,
});

