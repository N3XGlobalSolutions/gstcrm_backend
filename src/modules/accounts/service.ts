import { db } from "@/db";
import { AppError } from "@/types/errors";
import { generateEntryNo } from "@/lib/entryNoGenerator";
import { createEntryGroup } from "@/lib/entryBuilder";
import { getBalance, getAggregateBalances } from "@/lib/balance";
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
  getNextAccountEntryNo,
} from "./queries";
import { entryGroups } from "@/db/schema";
import { eq, and, isNotNull, desc, not } from "drizzle-orm";

// ─── listAccounts ─────────────────────────────────────────────────────────────

export async function listAccounts(input: z.infer<typeof ListAccountsSchema>) {
  return findManyAccounts(input);
}

// ─── createAccount ────────────────────────────────────────────────────────────

export async function createAccount(
  input: z.infer<typeof CreateAccountSchema>,
  creator: { id: string; username: string }
) {
  // Wrap the whole creation in a single transaction so account insert, opening
  // balance entries, and sequence generation are all atomic.
  const account = await db.transaction(async (tx) => {
    // Step 1: Generate entry_no inside the transaction (advisory lock is effective here)
    const entry_no = await generateEntryNo(tx as any, "accounts", input.type);

    const newAccount = await insertAccount(tx as any, {
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
    if (toDecimal(input.opening_pure_balance).gt(0)) {
      await createEntryGroup(
        {
          type: "OPENING",
          accountId: newAccount.id,
          date: today,
          remarks: "Opening pure balance",
          entries: [
            {
              fromAccountId: SYSTEM_ACCOUNTS.SHOP_ID,
              toAccountId: newAccount.id,
              itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID,
              quantity: "0",
              pureQuantity: input.opening_pure_balance,
            },
          ],
        },
        tx as any,
      );
    }

    // Step 3: Opening cash balance → OPENING entry: CASH → new account
    if (toDecimal(input.opening_cash_balance).gt(0)) {
      await createEntryGroup(
        {
          type: "OPENING",
          accountId: newAccount.id,
          date: today,
          remarks: "Opening cash balance",
          entries: [
            {
              fromAccountId: SYSTEM_ACCOUNTS.CASH_ID,
              toAccountId: newAccount.id,
              itemId: SYSTEM_ITEMS.RUPEE_ITEM_ID,
              quantity: input.opening_cash_balance,
            },
          ],
        },
        tx as any,
      );
    }

    return newAccount;
  });

  // Fire system notification AFTER the transaction commits, as a best-effort
  // side-effect. Never let a notification failure roll back the customer creation.
  if (input.type === "CUSTOMER") {
    createSystemNotification(
      db,
      `Customer '${account.name}' was created by ${creator.username}`,
      creator.id
    ).catch((err) =>
      console.error("Failed to create system notification for new customer:", err)
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
    createSystemNotification(
      db,
      `Customer '${input.name}' was updated by ${creator.username}`,
      creator.id
    ).catch((err) =>
      console.error("Failed to create system notification for customer update:", err)
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
    createSystemNotification(
      db,
      `Customer '${account.name}' was deleted by ${creator.username}`,
      creator.id
    ).catch((err) =>
      console.error("Failed to create system notification for customer delete:", err)
    );
  }

  return { success: true };
}

// ─── getAccountBalance ────────────────────────────────────────────────────────

export async function getAccountBalance(
  input: z.infer<typeof GetAccountBalanceSchema>,
) {
  const balance = await getBalance(input.accountId, input.itemId);
  return { balance: balance.toFixed(3) };
}

// ─── getAggregateBalances ──────────────────────────────────────────────────────

export async function getAccountAggregateBalances(
  input: z.infer<typeof GetAggregateBalancesSchema>,
) {
  const asOfDate = input.asOfDate ? new Date(input.asOfDate) : undefined;
  const balances = await getAggregateBalances(input.accountId, asOfDate, input.excludeGroupId);

  // Fetch the most recent sale rate for this account (excludes REVERSAL groups)
  const [lastGroup] = await db
    .select({ rate_per_gram: entryGroups.rate_per_gram })
    .from(entryGroups)
    .where(
      and(
        eq(entryGroups.account_id, input.accountId),
        eq(entryGroups.is_deleted, false),
        not(eq(entryGroups.type, "REVERSAL")),
        isNotNull(entryGroups.rate_per_gram),
      ),
    )
    .orderBy(desc(entryGroups.created_at))
    .limit(1);

  return {
    totalPure: balances.totalPure.toFixed(3),
    totalCash: balances.totalCash.toFixed(2),
    // Rate-stable opening balance in pure grams. 3dp = system standard for gold.
    balancePure: balances.balancePure.toFixed(3),
    lastRate: lastGroup?.rate_per_gram ?? null,
  };
}

export async function getAccountById(id: string) {
  return findAccountById(id);
}

export async function getNextEntryNo(type?: string) {
  return { nextEntryNo: await getNextAccountEntryNo(type) };
}
