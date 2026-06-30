import { z } from "zod";

export const ListExpenseSchema = z.object({
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
});

export const GetByIdSchema = z.object({ id: z.string().uuid() });

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format, expected YYYY-MM-DD");
const positiveDecimalSchema = z.string().refine(v => !isNaN(parseFloat(v)) && parseFloat(v) > 0, "Must be greater than zero");

export const CreateExpenseSchema = z.object({
  date: dateSchema,
  name: z.string().min(1),
  amount: positiveDecimalSchema,
  reason: z.string().min(1),
  from_account_id: z.string().uuid().optional(),
  bank_details: z.string().optional(),
});

export const UpdateExpenseSchema = CreateExpenseSchema.extend({
  id: z.string().uuid(),
});

export const DeleteExpenseSchema = z.object({ id: z.string().uuid() });
