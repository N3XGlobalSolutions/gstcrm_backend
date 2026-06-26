import { z } from "zod";

export const ListTxSchema = z.object({
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
  from_date: z.string().optional(),
  to_date: z.string().optional(),
});

export const GetByIdSchema = z.object({ id: z.string().uuid() });
export const DeleteTxSchema = z.object({ id: z.string().uuid() });

// ─── Bill Cycle schemas ────────────────────────────────────────────────────────

export const CreateCycleSchema = z.object({
  account_id: z.string().uuid(),
  main_reason: z.string().optional(),
});

export const ListCyclesSchema = z.object({
  account_id: z.string().uuid(),
});

export const GetCycleDetailSchema = z.object({
  cycle_id: z.string().uuid(),
});

// ─── Gold item (Issue or Receipt) ─────────────────────────────────────────────
const GoldItemSchema = z.object({
  item_id: z.string().uuid(),
  lot_id: z.string().optional(), // required for Issue (stock check), optional for Receipt
  quantity: z.string(),          // gross weight in grams
  purity: z.string(),            // touch percentage (e.g. "92")
});

// ─── Ornament item (Issue or Receipt) ─────────────────────────────────────────
// Wastage formula: wastage_gm = (quantity × wastage_percent/100) / (purity/100)
// gross = quantity + wastage_gm, pure = gross × (purity/100)
const OrnamentItemSchema = z.object({
  item_id: z.string().uuid(),
  lot_id: z.string().optional(), // required for Issue (stock check), optional for Receipt
  quantity: z.string(),          // base ornament weight
  purity: z.string(),            // touch percentage
  wastage_percent: z.string().default("0"),
});

// ─── Partial cash conversion ───────────────────────────────────────────────────
// Converts some pure gold owed by goldsmith into a cash debt
const CashConversionSchema = z.object({
  gold_grams: z.string(),        // pure gold grams being converted
  rate_per_gram: z.string(),     // rate applied
  cash_amount: z.string(),       // = gold_grams × rate_per_gram (pre-computed by frontend)
});

// ─── CreateLabourBill ──────────────────────────────────────────────────────────
export const CreateLabourBillSchema = z.object({
  account_id: z.string().uuid(),
  date: z.string(),
  rate_per_gram: z.string().optional(),
  remarks: z.string().optional(),

  // Bill Cycle: the permanent ledger this entry belongs to
  bill_cycle_id: z.string().uuid().optional(),

  // 4-direction stock entries (all between SHOP and GOLDSMITH)
  gold_issue:       z.array(GoldItemSchema).default([]),    // SHOP → Goldsmith
  gold_receipt:     z.array(GoldItemSchema).default([]),    // Goldsmith → SHOP
  ornament_issue:   z.array(OrnamentItemSchema).default([]),// SHOP → Goldsmith
  ornament_receipt: z.array(OrnamentItemSchema).default([]),// Goldsmith → SHOP

  // Cash settlements
  bank_paid:         z.string().optional(), // SHOP pays goldsmith (cash out)
  bank_paid_details: z.string().optional(),
  bank_receive:         z.string().optional(), // Goldsmith pays SHOP (cash in)
  bank_receive_details: z.string().optional(),
  discount:             z.string().optional(),
  tds:                  z.string().optional(),

  // Partial gold-to-cash conversions (each converts slip pure into cash debt)
  cash_conversions: z.array(CashConversionSchema).default([]),
});

export const UpdateLabourBillSchema = CreateLabourBillSchema.extend({
  id: z.string().uuid(),
});

// ─── Re-export types ───────────────────────────────────────────────────────────
export type CreateLabourBillInput = z.infer<typeof CreateLabourBillSchema>;
export type UpdateLabourBillInput = z.infer<typeof UpdateLabourBillSchema>;
export type CreateCycleInput = z.infer<typeof CreateCycleSchema>;
export type ListCyclesInput = z.infer<typeof ListCyclesSchema>;
export type GetCycleDetailInput = z.infer<typeof GetCycleDetailSchema>;
