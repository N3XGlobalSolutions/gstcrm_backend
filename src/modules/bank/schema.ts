import { z } from "zod";

// Bank pages are driven by the bank list configured in Settings → Company
// Details (company_details.bank_details, a JSON array). There is no separate
// bank master table: a bank is identified by the label the payment dropdowns
// write into entries.remarks.
export const BankLedgerSchema = z.object({
  // Bank key = `${bankName}|${accountNo}` (see buildBankKey). Omit for all banks.
  bankKey: z.string().optional(),
  from_date: z.string().optional(),
  to_date: z.string().optional(),
  // Transaction log paging — the log is one flat, newest-first list across the
  // selected scope. 10 rows per page.
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(100).default(10),
});

export type BankLedgerInput = z.infer<typeof BankLedgerSchema>;

const amountSchema = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,2})?$/, "Enter a valid amount")
  .refine((v) => Number.parseFloat(v) > 0, "Amount must be greater than zero");

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD");

// Money put into, or taken out of, one bank by hand.
export const AddBankFundsSchema = z.object({
  bankKey: z.string().min(1),
  direction: z.enum(["CREDIT", "DEBIT"]),
  amount: amountSchema,
  date: dateSchema,
  remarks: z.string().max(500).optional(),
});

export type AddBankFundsInput = z.infer<typeof AddBankFundsSchema>;

// The shop's own bank accounts, edited from the Bank page. They live in
// company_details.bank_details (a JSON array) because the Purchase/Sales payment
// dropdowns read them from there — one list, one source.
export const SaveBanksSchema = z.object({
  banks: z
    .array(
      z.object({
        bankName: z.string().trim().min(1, "Bank name is required").max(200),
        accountNo: z.string().trim().max(30).default(""),
        ifscCode: z.string().trim().max(15).default(""),
        branch: z.string().trim().max(200).default(""),
        openingBalance: z
          .string()
          .trim()
          .regex(/^-?\d*(\.\d{1,2})?$/, "Opening balance must be a number")
          .default(""),
      }),
    )
    .max(50),
});

export type SaveBanksInput = z.infer<typeof SaveBanksSchema>;

// Money moved between two of the shop's own banks.
export const TransferBankFundsSchema = z
  .object({
    fromBankKey: z.string().min(1),
    toBankKey: z.string().min(1),
    amount: amountSchema,
    date: dateSchema,
    remarks: z.string().max(500).optional(),
  })
  .refine((v) => v.fromBankKey !== v.toBankKey, {
    message: "Choose two different banks",
    path: ["toBankKey"],
  });

export type TransferBankFundsInput = z.infer<typeof TransferBankFundsSchema>;
