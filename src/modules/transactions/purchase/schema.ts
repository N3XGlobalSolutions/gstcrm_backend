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

const PurchaseItemSchema = z.object({
  item_id: z.string().uuid(),
  quantity: z.string(),
  purity: z.string(),
});

export const CreatePurchaseSchema = z.object({
  account_id: z.string().uuid(),
  date: z.string(),
  rate_per_gram: z.string(),
  remarks: z.string().optional(),
  gold_items: z.array(PurchaseItemSchema).default([]),
  ornament_items: z.array(PurchaseItemSchema).default([]),
  bank_amount: z.string().default("0"),
  bank_details: z.string().optional(),
  discount: z.string().optional(),
  discount_pure: z.string().optional(),
});

export const UpdatePurchaseSchema = CreatePurchaseSchema.extend({
  id: z.string().uuid(),
});

export const UpdateGSTPurchaseConversionSchema = z.object({
  id: z.string().uuid(),
  gst_amount: z.string(),
  tds_amount: z.string(),
  tcs_amount: z.string(),
});

