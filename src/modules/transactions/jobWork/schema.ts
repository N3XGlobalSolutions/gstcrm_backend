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

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format, expected YYYY-MM-DD");
const positiveDecimalSchema = z.string().refine(v => !isNaN(parseFloat(v)) && parseFloat(v) > 0, "Must be greater than zero");
const nonNegativeDecimalSchema = z.string().refine(v => !isNaN(parseFloat(v)) && parseFloat(v) >= 0, "Must be non-negative");
const puritySchema = z.string().refine(v => {
  const p = parseFloat(v);
  return !isNaN(p) && p > 0 && p <= 100;
}, "Purity must be between 0.01% and 100%");

const JobWorkGoldItemSchema = z.object({
  item_id: z.string().uuid(),
  lot_id: z.string().optional(),
  quantity: positiveDecimalSchema,
  purity: puritySchema,
  actual_purity: puritySchema.optional(),
});

const JobWorkOrnamentItemSchema = z.object({
  item_id: z.string().uuid(),
  lot_id: z.string().optional(),
  quantity: positiveDecimalSchema,
  purity: puritySchema,
  stone: nonNegativeDecimalSchema.optional(),
  throde: nonNegativeDecimalSchema.optional(),
  chain: nonNegativeDecimalSchema.optional(),
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

export const CreateJobWorkSchema = z.object({
  account_id: z.string().uuid(),
  date: dateSchema,
  remarks: z.string().optional(),
  gold_issue: z.array(JobWorkGoldItemSchema).default([]),
  ornament_issue: z.array(JobWorkOrnamentItemSchema).default([]),
  gold_receipt: z.array(JobWorkGoldItemSchema).default([]),
  ornament_receipt: z.array(JobWorkOrnamentItemSchema).default([]),
});

export const UpdateJobWorkSchema = CreateJobWorkSchema.extend({
  id: z.string().uuid(),
});
