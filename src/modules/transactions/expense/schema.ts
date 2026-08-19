import { z } from "zod";

export const ListExpenseSchema = z.object({
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
});

export const GetByIdSchema = z.object({ id: z.string().uuid() });

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format, expected YYYY-MM-DD");
const positiveDecimalSchema = z.string().refine(v => !isNaN(parseFloat(v)) && parseFloat(v) > 0, "Must be greater than zero");

// Zod's built-in .uuid() enforces the strict RFC 4122 version/variant nibbles and
// only special-cases the literal all-zero/all-F UUIDs — it rejects this app's
// system account IDs (e.g. CASH_ID = "00000000-0000-0000-0000-000000000002",
// sent here when "Paid From: Cash" is selected), even though Postgres accepts
// them fine as a uuid column. Accept any well-formed 8-4-4-4-12 hex UUID instead.
const looseUuidSchema = z.string().regex(
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
  "Invalid UUID",
);

export const CreateExpenseSchema = z.object({
  date: dateSchema,
  name: z.string().min(1),
  amount: positiveDecimalSchema,
  reason: z.string().min(1),
  from_account_id: looseUuidSchema.optional(),
  bank_details: z.string().optional(),
});

export const UpdateExpenseSchema = CreateExpenseSchema.extend({
  id: z.string().uuid(),
});

export const DeleteExpenseSchema = z.object({ id: z.string().uuid() });
