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
// Converts some pure gold owed by goldsmith into a cash debt
const CashConversionSchema = z.object({
  gold_grams: positiveDecimalSchema,        // pure gold grams being converted — must be > 0
  rate_per_gram: positiveDecimalSchema,     // rate applied — must be > 0 (zero-rate conversions blocked)
  cash_amount: positiveDecimalSchema,       // = gold_grams × rate_per_gram (pre-computed by frontend) — must be > 0
}).refine(
  d => Math.abs(parseFloat(d.gold_grams) * parseFloat(d.rate_per_gram) - parseFloat(d.cash_amount)) < 0.01,
  { message: "cash_amount must equal gold_grams × rate_per_gram (within ₹0.01 tolerance)", path: ["cash_amount"] }
);

// ─── CreateLabourBill ──────────────────────────────────────────────────────────
export const CreateLabourBillSchema = z.object({
  account_id: z.string().uuid(),
  date: dateSchema,
  // Rate/Gm is MANDATORY on a labour bill: every cash figure on the slip is derived
  // from it, so a bill saved without one has a silently-zeroed money side.
  // positiveDecimalSchema also enforces > 0, so "0" is rejected too.
  rate_per_gram: positiveDecimalSchema,
  remarks: z.string().optional(),

  // Bill Cycle: the permanent ledger this entry belongs to.
  // REQUIRED — a labour bill must always be posted inside a cycle. Without it the
  // entry builder would fall back to auto-numbering bill_no (MAX+1), producing a
  // phantom "bill" that maps to no real cycle. See createLabourBill guard.
  bill_cycle_id: z.string().uuid({ message: "A bill cycle must be selected before saving a labour bill." }),

  // 4-direction stock entries (all between SHOP and GOLDSMITH)
  gold_issue:       z.array(GoldItemSchema).default([]),    // SHOP → Goldsmith
  gold_receipt:     z.array(GoldItemSchema).default([]),    // Goldsmith → SHOP
  ornament_issue:   z.array(OrnamentItemSchema).default([]),// SHOP → Goldsmith
  ornament_receipt: z.array(OrnamentItemSchema).default([]),// Goldsmith → SHOP

  // Cash settlements
  bank_paid:         positiveDecimalSchema.optional(), // SHOP pays goldsmith (cash out) — must be > 0 if provided
  bank_paid_details: z.string().optional(),
  bank_receive:         positiveDecimalSchema.optional(), // Goldsmith pays SHOP (cash in) — must be > 0 if provided
  bank_receive_details: z.string().optional(),
  discount:             positiveDecimalSchema.optional(), // must be > 0 if provided

  // TDS/TCS — same convention as Purchase/Sales: TDS subtracts from what the
  // goldsmith owes, TCS adds to it. Amount is precomputed on the frontend
  // (percent × taxable base, net of the 3% GST portion) and sent as a fixed
  // rupee figure, same pattern as Purchase/Sales.
  tds_enabled: z.boolean().optional(),
  tds_amount:  positiveDecimalSchema.optional(),
  tcs_enabled: z.boolean().optional(),
  tcs_amount:  positiveDecimalSchema.optional(),

  // Partial gold-to-cash conversions (each converts slip pure into cash debt)
  cash_conversions: z.array(CashConversionSchema).default([]),
});

export const UpdateLabourBillSchema = CreateLabourBillSchema.extend({
  id: z.string().uuid(),
});

// ─── Gold-to-cash / cash-to-gold conversion (opening balance) ─────────────────
// Converts part of a goldsmith's carried-forward opening balance — independent
// of any bill currently being drafted, same as Purchase's account-level convert.

export const ConvertGoldToCashSchema = z.object({
  account_id: z.string().uuid(),
  gold_grams: positiveDecimalSchema,      // pure gold grams being converted — must be > 0
  rate_per_gram: positiveDecimalSchema,   // rate applied — must be > 0
});

export const ConvertCashToGoldSchema = z.object({
  account_id: z.string().uuid(),
  cash_amount: positiveDecimalSchema,     // cash being converted — must be > 0
  rate_per_gram: positiveDecimalSchema,   // rate applied — must be > 0
});

// ─── Standalone cash receive (no bill/cycle required) ─────────────────────────
// A goldsmith paying the shop cash outside of any item bill — just pick the
// goldsmith and record it, same "independent of any bill" pattern as the
// gold/cash conversions above.
export const ReceiveCashSchema = z.object({
  account_id: z.string().uuid(),
  amount: positiveDecimalSchema,    // cash amount received — must be > 0
  date: dateSchema,
  details: z.string().optional(),  // bank name/A/C or "Cash"
});

// ─── Re-export types ───────────────────────────────────────────────────────────
export type CreateLabourBillInput = z.infer<typeof CreateLabourBillSchema>;
export type UpdateLabourBillInput = z.infer<typeof UpdateLabourBillSchema>;
export type CreateCycleInput = z.infer<typeof CreateCycleSchema>;
export type ListCyclesInput = z.infer<typeof ListCyclesSchema>;
export type GetCycleDetailInput = z.infer<typeof GetCycleDetailSchema>;
