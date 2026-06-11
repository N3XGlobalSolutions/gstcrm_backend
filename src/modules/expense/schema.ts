import { z } from "zod";

// ─── Expense ──────────────────────────────────────────────────────────────────

export const ListExpensesSchema = z.object({
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(200).default(20),
  search: z.string().optional(),
  from_date: z.string().optional(),
  to_date: z.string().optional(),
});

export const CreateExpenseSchema = z.object({
  date: z.string(),
  name: z.string().min(1),
  amount: z.string(), // decimal string
  reason: z.string().optional(),
});

export const UpdateExpenseSchema = CreateExpenseSchema.extend({
  id: z.string().uuid(),
});

export const DeleteExpenseSchema = z.object({ id: z.string().uuid() });

// ─── Notification ─────────────────────────────────────────────────────────────

export const ListNotificationsSchema = z.object({
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(50).default(10),
});

export const CreateNotificationSchema = z.object({
  message: z.string().min(1),
});

export const DeleteNotificationSchema = z.object({ id: z.string().uuid() });

// ─── Inferred types ───────────────────────────────────────────────────────────

export type ListExpensesInput = z.infer<typeof ListExpensesSchema>;
export type CreateExpenseInput = z.infer<typeof CreateExpenseSchema>;
export type UpdateExpenseInput = z.infer<typeof UpdateExpenseSchema>;
export type DeleteExpenseInput = z.infer<typeof DeleteExpenseSchema>;

export type ListNotificationsInput = z.infer<typeof ListNotificationsSchema>;
export type CreateNotificationInput = z.infer<typeof CreateNotificationSchema>;
export type DeleteNotificationInput = z.infer<typeof DeleteNotificationSchema>;
