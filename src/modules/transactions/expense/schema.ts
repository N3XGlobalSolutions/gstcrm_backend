import { z } from "zod";

export const ListExpenseSchema = z.object({
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
});

export const GetByIdSchema = z.object({ id: z.string().uuid() });

export const CreateExpenseSchema = z.object({
  date: z.string(),
  name: z.string().min(1),
  amount: z.string(),
  reason: z.string().min(1),
  from_account_id: z.string().uuid().optional(),
  bank_details: z.string().optional(),
});

export const UpdateExpenseSchema = CreateExpenseSchema.extend({
  id: z.string().uuid(),
});

export const DeleteExpenseSchema = z.object({ id: z.string().uuid() });
