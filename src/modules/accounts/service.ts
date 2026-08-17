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
  const result = await findManyAccounts(input);
  const dataWithBalances = await Promise.all(
    result.data.map(async (acc) => {
      const balances = await getAggregateBalances(acc.id);
      return {
        ...acc,
        opening_pure_balance: balances.totalPure.toFixed(3),
        opening_cash_balance: balances.totalCash.toFixed(2),
      };
    })
  );
  return {
    data: dataWithBalances,
    total: result.total,
  };
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
      state_code: input.state_code ?? (input.type === "CUSTOMER" ? "33" : null),
      place_of_supply: input.place_of_supply ?? (input.type === "CUSTOMER" && input.customer_type !== "GOLD_SMITH" ? "Tamil Nadu" : null),
      address: input.address ?? null,
      phone: input.phone ?? null,
      email: input.email ?? null,
      website: input.website ?? null,
      bank_name: input.bank_name ?? null,
      bank_account_no: input.bank_account_no ?? null,
      ifsc_code: input.ifsc_code ?? null,
      default_tds_percent: input.default_tds_percent ?? null,
      default_tcs_percent: input.default_tcs_percent ?? null,
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
    bank_name: input.bank_name ?? null,
    bank_account_no: input.bank_account_no ?? null,
    ifsc_code: input.ifsc_code ?? null,
    default_tds_percent: input.default_tds_percent ?? null,
    default_tcs_percent: input.default_tcs_percent ?? null,
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

  // goldCashBalance = (goldCashOut - goldCashIn) - totalCash
  //   goldCashOut  = Σ(pure × rate) for all gold the account has SENT (sold to shop)
  //   goldCashIn   = Σ(pure × rate) for all gold the account has RECEIVED
  //   totalCash    = net cash payments received by the account
  // For purchase suppliers this is the exact cash the shop still owes them:
  //   every prior bill's gold value at its own rate, minus every payment received.
  //   Netting goldCashIn cancels a reversed bill's gold value (reversal swaps from/to),
  //   so an edited bill never leaves a stale amount in the opening balance.
  const lastRateVal = toDecimal(lastGroup?.rate_per_gram ?? "0");
  const goldCashBalance = lastRateVal.gt(0)
    ? balances.balancePure.mul(lastRateVal).abs()
    : balances.goldCashOut.minus(balances.goldCashIn).minus(balances.totalCash).abs();

  return {
    totalPure: balances.totalPure.toFixed(3),
    totalCash: balances.totalCash.toFixed(2),
    // Rate-stable opening balance in pure grams. 3dp = system standard for gold.
    balancePure: balances.balancePure.toFixed(3),
    lastRate: lastGroup?.rate_per_gram ?? null,
    // Opening Cash is ALWAYS Opening Pure × Rate (consistent everywhere)
    goldCashBalance: goldCashBalance.toFixed(2),
    // True independent cash ledger balance (cash inflow - cash outflow, no gold conversion).
    // Use this as the opening cash when the bill is in Cash mode.
    cashBalance: balances.totalCash.toFixed(2),
    // Net grams from rate-less opening-pure entries — carried forward as grams as-is,
    // since they have no cash side and must not be routed through the cash-first balance.
    pureNoRate: balances.pureNoRate.toFixed(3),
  };
}

export async function getAccountById(id: string) {
  return findAccountById(id);
}

export async function getNextEntryNo(type?: string) {
  return { nextEntryNo: await getNextAccountEntryNo(type) };
}
