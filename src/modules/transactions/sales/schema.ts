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

const SalesItemSchema = z.object({
  item_id: z.string().uuid(),
  lot_id: z.string().min(1, "Lot ID is required"),
  quantity: z.string(),
  purity: z.string(),
  wastage_mode: z.enum(["PERCENT", "GRAM"]),
  wastage_value: z.string(),
});

export const CreateSalesSchema = z.object({
  account_id: z.string().uuid(),
  date: z.string(),
  rate_per_gram: z.string(),
  remarks: z.string().optional(),
  items: z.array(SalesItemSchema).min(1),
  bank_amount: z.string().default('0'),
  bank_details: z.string().optional(),
  // Discount fields — applied to reduce customer balance in the ledger.
  discount: z.string().default('0'),
  discount_pure: z.string().default('0'),
  balance_mode: z.enum(['PURE', 'CASH']).default('PURE'),
  rate_for_balance: z.string().optional(),
  // TDS/TCS — tax withholding adjustments that affect the running balance.
  tds_enabled: z.boolean().default(false),
  tds_amount: z.string().default('0'),
  tcs_enabled: z.boolean().default(false),
  tcs_amount: z.string().default('0'),
});

export const UpdateSalesSchema = CreateSalesSchema.extend({
  id: z.string().uuid(),
});

export const UpdateGSTConversionSchema = z.object({
  id: z.string().uuid(),
  gst_amount: z.string(),
  tds_amount: z.string(),
  tcs_amount: z.string(),
});
