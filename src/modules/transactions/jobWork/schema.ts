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

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format, expected YYYY-MM-DD");
const positiveDecimalSchema = z.string().refine(
  v => !isNaN(parseFloat(v)) && parseFloat(v) > 0,
  "Must be a positive number (greater than zero)"
);
const nonNegativeDecimalSchema = z.string().refine(
  v => !isNaN(parseFloat(v)) && parseFloat(v) >= 0,
  "Must be a non-negative number"
);
// strict bounds: purity must be in range (0, 100] — blocks > 100% and zero
const puritySchema = z.string().refine(v => {
  const p = parseFloat(v);
  return !isNaN(p) && p > 0 && p <= 100;
}, "Purity must be between 0.01% and 100% — values above 100% are not permitted");

// ─── Gold item (Issue or Receipt) ─────────────────────────────────────────────
const GoldItemSchema = z.object({
  item_id: z.string().uuid(),
  lot_id: z.string().optional(), // required for Issue (stock check), optional for Receipt
  quantity: positiveDecimalSchema,          // gross weight in grams
  purity: puritySchema,            // touch percentage (e.g. "92")
});

// ─── Ornament item (Issue or Receipt) ─────────────────────────────────────────
// Wastage formula: wastage_gm = (quantity × wastage_percent/100) / (purity/100)
// gross = quantity + wastage_gm, pure = gross × (purity/100)
const wastagePercentSchema = z.string().refine(v => {
  const w = parseFloat(v);
  return !isNaN(w) && w >= 0 && w <= 100;
}, "Wastage percentage must be between 0% and 100%");

const OrnamentItemSchema = z.object({
  item_id: z.string().uuid(),
  lot_id: z.string().optional(), // required for Issue (stock check), optional for Receipt
  quantity: positiveDecimalSchema,          // base ornament weight
  purity: puritySchema,            // touch percentage
  wastage_percent: wastagePercentSchema.default("0"),
});

// ─── Partial cash conversion ───────────────────────────────────────────────────
// Converts some pure gold owed by the account into a cash debt
const CashConversionSchema = z.object({
  gold_grams: positiveDecimalSchema,        // pure gold grams being converted — must be > 0
  rate_per_gram: positiveDecimalSchema,     // rate applied — must be > 0 (zero-rate conversions blocked)
  cash_amount: positiveDecimalSchema,       // = gold_grams × rate_per_gram (pre-computed by frontend) — must be > 0
}).refine(
  d => Math.abs(parseFloat(d.gold_grams) * parseFloat(d.rate_per_gram) - parseFloat(d.cash_amount)) < 0.01,
  { message: "cash_amount must equal gold_grams × rate_per_gram (within ₹0.01 tolerance)", path: ["cash_amount"] }
);

// ─── CreateJobWork ─────────────────────────────────────────────────────────────
export const CreateJobWorkSchema = z.object({
  account_id: z.string().uuid(),
  date: dateSchema,
  // rate_per_gram: positiveDecimalSchema enforces > 0 — zero rates blocked
  rate_per_gram: positiveDecimalSchema.optional(),
  remarks: z.string().optional(),

  // Bill Cycle: the permanent ledger this entry belongs to.
  // REQUIRED — a job work must always be posted inside a cycle. Without it the
  // entry builder would fall back to auto-numbering bill_no (MAX+1), producing a
  // phantom "bill" that maps to no real cycle. See createJobWork guard.
  bill_cycle_id: z.string().uuid({ message: "A bill cycle must be selected before saving a job work." }),

  // 4-direction stock entries (all between SHOP and the account)
  gold_issue:       z.array(GoldItemSchema).default([]),    // SHOP → Account
  gold_receipt:     z.array(GoldItemSchema).default([]),    // Account → SHOP
  ornament_issue:   z.array(OrnamentItemSchema).default([]),// SHOP → Account
  ornament_receipt: z.array(OrnamentItemSchema).default([]),// Account → SHOP

  // Cash settlements
  bank_paid:         positiveDecimalSchema.optional(), // SHOP pays account (cash out) — must be > 0 if provided
  bank_paid_details: z.string().optional(),
  bank_receive:         positiveDecimalSchema.optional(), // Account pays SHOP (cash in) — must be > 0 if provided
  bank_receive_details: z.string().optional(),
  discount:             positiveDecimalSchema.optional(), // must be > 0 if provided
  tds:                  positiveDecimalSchema.optional(), // must be > 0 if provided

  // Partial gold-to-cash conversions (each converts slip pure into cash debt)
  cash_conversions: z.array(CashConversionSchema).default([]),
});

export const UpdateJobWorkSchema = CreateJobWorkSchema.extend({
  id: z.string().uuid(),
});

// ─── Re-export types ───────────────────────────────────────────────────────────
export type CreateJobWorkInput = z.infer<typeof CreateJobWorkSchema>;
export type UpdateJobWorkInput = z.infer<typeof UpdateJobWorkSchema>;
export type CreateCycleInput = z.infer<typeof CreateCycleSchema>;
export type ListCyclesInput = z.infer<typeof ListCyclesSchema>;
export type GetCycleDetailInput = z.infer<typeof GetCycleDetailSchema>;
