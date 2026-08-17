import { z } from "zod";

// ─── accounts.list ────────────────────────────────────────────────────────────

export const ListAccountsSchema = z.object({
  type: z
    .enum(["SHOP", "CUSTOMER", "GOLDSMITH", "CASH", "BANK", "EXPENSE", "LOSS"])
    .optional(),
  customer_type: z
    .enum(["PURCHASER", "CUSTOMER", "GOLD_SMITH", "SALES_MAN", "LABOUR_BILL"])
    .optional(),
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(500).default(20),
  search: z.string().optional(),
});

// ─── accounts.create ──────────────────────────────────────────────────────────

export const CreateAccountSchema = z.object({
  name: z.string().min(1).max(200),
  type: z.enum(["SHOP", "CUSTOMER", "GOLDSMITH", "CASH", "BANK", "EXPENSE", "LOSS"]),
  customer_type: z
    .enum(["PURCHASER", "CUSTOMER", "GOLD_SMITH", "SALES_MAN", "LABOUR_BILL"])
    .optional()
    .nullable(),
  gst_no: z.string().max(20).optional().nullable(),
  pan_no: z.string().max(10).optional().nullable(),
  state_code: z.string().max(10).optional().nullable(),
  place_of_supply: z.string().max(100).optional().nullable(),
  address: z.string().optional().nullable(),
  phone: z.string().max(15).optional().nullable(),
  email: z.string().max(200).optional().nullable(),
  website: z.string().max(200).optional().nullable(),
  bank_name: z.string().max(200).optional().nullable(),
  bank_account_no: z.string().max(30).optional().nullable(),
  ifsc_code: z.string().max(15).optional().nullable(),
  default_tds_percent: z.string().optional().nullable(),
  default_tcs_percent: z.string().optional().nullable(),
  opening_pure_balance: z.string().default("0"), // decimal string
  opening_cash_balance: z.string().default("0"), // decimal string
});

// ─── accounts.update ──────────────────────────────────────────────────────────

export const UpdateAccountSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(200),
  customer_type: z
    .enum(["PURCHASER", "CUSTOMER", "GOLD_SMITH", "SALES_MAN", "LABOUR_BILL"])
    .optional()
    .nullable(),
  gst_no: z.string().max(20).optional().nullable(),
  pan_no: z.string().max(10).optional().nullable(),
  state_code: z.string().max(10).optional().nullable(),
  place_of_supply: z.string().max(100).optional().nullable(),
  address: z.string().optional().nullable(),
  phone: z.string().max(15).optional().nullable(),
  email: z.string().max(200).optional().nullable(),
  website: z.string().max(200).optional().nullable(),
  bank_name: z.string().max(200).optional().nullable(),
  bank_account_no: z.string().max(30).optional().nullable(),
  ifsc_code: z.string().max(15).optional().nullable(),
  default_tds_percent: z.string().optional().nullable(),
  default_tcs_percent: z.string().optional().nullable(),
  updated_at: z.string(), // ISO timestamp — optimistic lock
});

// ─── accounts.delete ──────────────────────────────────────────────────────────

export const DeleteAccountSchema = z.object({
  id: z.string().uuid(),
});

// ─── accounts.getBalance ──────────────────────────────────────────────────────

export const GetAccountBalanceSchema = z.object({
  accountId: z.string().uuid(),
  itemId: z.string().uuid(),
});

// ─── accounts.getAggregateBalances ────────────────────────────────────────────

export const GetAggregateBalancesSchema = z.object({
  accountId: z.string().uuid(),
  asOfDate: z.string().optional(),
  excludeGroupId: z.string().uuid().optional(),
});
