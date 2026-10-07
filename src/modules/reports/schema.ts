import { z } from "zod";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD");

/** Bill-based reports — one per entry-group type. */
export const ReportTypeSchema = z.enum([
  "SALE",
  "PURCHASE",
  "LABOUR_BILL",
  "JOB_WORK",
  "EXPENSE",
]);

export const TransactionReportSchema = z.object({
  type: ReportTypeSchema,
  from_date: dateSchema,
  to_date: dateSchema,
  group_by: z.enum(["day", "month"]).default("day"),
  // Optional party (customer / supplier / goldsmith / expense head) filter.
  account_id: z.string().uuid().optional(),
});

/** Bill-by-bill detail (every line, charge and payment) for one bill type. */
export const DetailedReportSchema = z.object({
  type: z.enum(["SALE", "PURCHASE", "LABOUR_BILL", "JOB_WORK"]),
  from_date: dateSchema,
  to_date: dateSchema,
  account_id: z.string().uuid().optional(),
});

export const BankReportSchema = z.object({
  from_date: dateSchema,
  to_date: dateSchema,
  group_by: z.enum(["day", "month"]).default("day"),
  bank_key: z.string().optional(),
});

export const StockReportSchema = z.object({
  from_date: dateSchema,
  to_date: dateSchema,
  group_by: z.enum(["day", "month"]).default("day"),
});

export type TransactionReportInput = z.infer<typeof TransactionReportSchema>;
export type DetailedReportInput = z.infer<typeof DetailedReportSchema>;
export type BankReportInput = z.infer<typeof BankReportSchema>;
export type StockReportInput = z.infer<typeof StockReportSchema>;
