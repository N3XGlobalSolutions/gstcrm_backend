import { db } from "@/db";
import { AppError } from "@/types/errors";
import { generateEntryNo } from "@/lib/entryNoGenerator";
import { createEntryGroup } from "@/lib/entryBuilder";
import { getBalance } from "@/lib/balance";
import { toDecimal } from "@/lib/decimal";
import { SYSTEM_ACCOUNTS, SYSTEM_ITEMS } from "@/config/constants";
import type { z } from "zod";
import { createSystemNotification } from "@/modules/notifications/service";
import type {
  ListAccountsSchema,
  CreateAccountSchema,
  UpdateAccountSchema,
  DeleteAccountSchema,
  GetAccountBalanceSchema,
  GetAggregateBalancesSchema,
} from "./schema";
import {
  findManyAccounts,
  findAccountById,
  hasTransactionHistory,
  insertAccount,
  updateAccount,
  softDeleteAccount,
} from "./queries";

// ─── listAccounts ─────────────────────────────────────────────────────────────

export async function listAccounts(input: z.infer<typeof ListAccountsSchema>) {
  return findManyAccounts(input);
}

// ─── createAccount ────────────────────────────────────────────────────────────

export async function createAccount(
  input: z.infer<typeof CreateAccountSchema>,
  creator: { id: string; username: string }
) {
  // Step 1: Insert the account row (committed immediately so FK on entry_groups works)
  const entry_no = await generateEntryNo(db, "accounts");

  const account = await insertAccount(db as any, {
    entry_no,
    name: input.name,
    type: input.type,
    customer_type: input.customer_type ?? null,
    gst_no: input.gst_no ?? null,
    pan_no: input.pan_no ?? null,
    state_code: input.state_code ?? null,
    place_of_supply: input.place_of_supply ?? null,
    address: input.address ?? null,
    phone: input.phone ?? null,
    email: input.email ?? null,
    website: input.website ?? null,
    opening_pure_balance: input.opening_pure_balance,
    opening_cash_balance: input.opening_cash_balance,
  });

  const today = new Date().toISOString().split("T")[0]!;

  // Step 2: Opening pure balance → OPENING entry: SHOP → new account
  // NOTE: Opening balance changes do NOT retroactively alter ledger entries (by design)
  if (toDecimal(input.opening_pure_balance).gt(0)) {
    await createEntryGroup({
      type: "OPENING",
      accountId: account.id,
      date: today,
      remarks: "Opening pure balance",
      entries: [
        {
          fromAccountId: SYSTEM_ACCOUNTS.SHOP_ID,
          toAccountId: account.id,
          itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID,
          quantity: input.opening_pure_balance,
        },
      ],
    });
  }

  // Step 3: Opening cash balance → OPENING entry: CASH → new account
  if (toDecimal(input.opening_cash_balance).gt(0)) {
    await createEntryGroup({
      type: "OPENING",
      accountId: account.id,
      date: today,
      remarks: "Opening cash balance",
      entries: [
        {
          fromAccountId: SYSTEM_ACCOUNTS.CASH_ID,
          toAccountId: account.id,
          itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID,
          quantity: input.opening_cash_balance,
        },
      ],
    });
  }

  if (input.type === "CUSTOMER") {
    await createSystemNotification(
      db,
      `Customer '${account.name}' was created by ${creator.username}`,
      creator.id
    );
  }

  return account;
}

// ─── updateAccount ────────────────────────────────────────────────────────────

export async function updateAccountById(
  input: z.infer<typeof UpdateAccountSchema>,
  creator: { id: string; username: string }
) {
  const current = await findAccountById(input.id);
  if (!current) throw new AppError("NOT_FOUND", "Account not found");

  // Optimistic locking — compare updated_at timestamps
  const currentTs = current.updated_at.toISOString();
  const submittedTs = new Date(input.updated_at).toISOString();
  if (currentTs !== submittedTs) {
    throw new AppError(
      "CONFLICT",
      "Record was modified by another user. Please reload and try again.",
    );
  }

  // Opening balance changes do NOT retroactively alter ledger entries — by design
  const updated = await updateAccount(input.id, {
    name: input.name,
    customer_type: input.customer_type ?? null,
    gst_no: input.gst_no ?? null,
    pan_no: input.pan_no ?? null,
    state_code: input.state_code ?? null,
    place_of_supply: input.place_of_supply ?? null,
    address: input.address ?? null,
    phone: input.phone ?? null,
    email: input.email ?? null,
    website: input.website ?? null,
  });

  if (current.type === "CUSTOMER") {
    await createSystemNotification(
      db,
      `Customer '${input.name}' was updated by ${creator.username}`,
      creator.id
    );
  }

  return updated;
}

// ─── deleteAccount ────────────────────────────────────────────────────────────

export async function deleteAccount(
  input: z.infer<typeof DeleteAccountSchema>,
  creator: { id: string; username: string }
) {
  const account = await findAccountById(input.id);
  if (!account) throw new AppError("NOT_FOUND", "Account not found");

  if (account.is_system_account) {
    throw new AppError(
      "BUSINESS_RULE_VIOLATION",
      "System accounts cannot be deleted",
    );
  }

  const hasTx = await hasTransactionHistory(input.id);
  if (hasTx) {
    throw new AppError(
      "BUSINESS_RULE_VIOLATION",
      "Account has transaction history and cannot be deleted",
    );
  }

  await softDeleteAccount(input.id);

  if (account.type === "CUSTOMER") {
    await createSystemNotification(
      db,
      `Customer '${account.name}' was deleted by ${creator.username}`,
      creator.id
    );
  }

  return { success: true };
}

// ─── getAccountBalance ────────────────────────────────────────────────────────

export async function getAccountBalance(
  input: z.infer<typeof GetAccountBalanceSchema>,
) {
  const balance = await getBalance(input.accountId, input.itemId);
  return { balance: balance.toFixed(8) };
}

// ─── getAggregateBalances ──────────────────────────────────────────────────────

export async function getAccountAggregateBalances(
  input: z.infer<typeof GetAggregateBalancesSchema>,
) {
  const { getAggregateBalances } = await import("@/lib/balance");
  const { entryGroups } = await import("@/db/schema");
  const { eq, and, isNotNull, desc, not } = await import("drizzle-orm");

  const asOfDate = input.asOfDate ? new Date(input.asOfDate) : undefined;
  const balances = await getAggregateBalances(input.accountId, asOfDate, input.excludeGroupId);

  // Fetch the most recent rate for this account (from any PURCHASE transaction)
  const [lastGroup] = await db
    .select({ rate_per_gram: entryGroups.rate_per_gram })
    .from(entryGroups)
    .where(
      and(
        eq(entryGroups.account_id, input.accountId),
        eq(entryGroups.is_deleted, false),
        not(eq(entryGroups.type, 'REVERSAL')),
        isNotNull(entryGroups.rate_per_gram),
      ),
    )
    .orderBy(desc(entryGroups.created_at))
    .limit(1);

  return {
    totalPure: balances.totalPure.toFixed(8),
    totalCash: balances.totalCash.toFixed(2),
    lastRate: lastGroup?.rate_per_gram ?? null,
  };
}

export async function getAccountById(id: string) {
  return findAccountById(id);
}

