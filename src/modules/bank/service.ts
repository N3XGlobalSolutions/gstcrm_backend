import { and, asc, eq, gte, isNotNull, lte, ne, notInArray } from "drizzle-orm";
import { db } from "@/db";
import {
  accounts,
  bankTransactions,
  companyDetails,
  entries,
  entryGroups,
} from "@/db/schema";
import { SYSTEM_ACCOUNTS, SYSTEM_ITEMS } from "@/config/constants";
import { AppError } from "@/types/errors";
import type {
  AddBankFundsInput,
  BankLedgerInput,
  TransferBankFundsInput,
} from "./schema";

// ─── Bank list ────────────────────────────────────────────────────────────────
// Banks live in company_details.bank_details as a JSON array — the same list the
// Purchase/Sales/Expense payment dropdowns read. We never invent a bank here, so
// this page and those dropdowns can never drift apart.

export interface BankAccountConfig {
  key: string;
  bankName: string;
  accountNo: string;
  ifscCode: string;
  branch: string;
  openingBalance: string;
  // Exact string the payment dropdowns write into entries.remarks.
  label: string;
}

export function buildBankKey(bankName: string, accountNo: string): string {
  return `${bankName.trim().toLowerCase()}|${accountNo.trim().toLowerCase()}`;
}

// Mirrors getAccountOptionValue() in PurchaseBillingDetails / *PaymentModal.
function buildBankLabel(acc: {
  bankName: string;
  accountNo: string;
  ifscCode: string;
}): string {
  return `${acc.bankName}${acc.accountNo ? ` - A/C: ${acc.accountNo}` : ""}${
    acc.ifscCode ? ` (${acc.ifscCode})` : ""
  }`;
}

export async function listBanks(): Promise<BankAccountConfig[]> {
  const [company] = await db.select().from(companyDetails).limit(1);
  const raw = company?.bank_details;
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Legacy rows stored a single free-text bank name instead of JSON.
    parsed = [{ bankName: raw }];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed
    .map((item) => {
      const row = item as Record<string, unknown>;
      const bankName = String(row.bankName ?? "").trim();
      const accountNo = String(row.accountNo ?? "").trim();
      const ifscCode = String(row.ifscCode ?? "").trim();
      const branch = String(row.branch ?? "").trim();
      return {
        key: buildBankKey(bankName, accountNo),
        bankName,
        accountNo,
        ifscCode,
        branch,
        openingBalance: String(row.openingBalance ?? "0") || "0",
        label: buildBankLabel({ bankName, accountNo, ifscCode }),
      };
    })
    .filter((b) => b.bankName.length > 0);
}

async function requireBank(bankKey: string): Promise<BankAccountConfig> {
  const bank = (await listBanks()).find((b) => b.key === bankKey);
  if (!bank) {
    throw new AppError(
      "NOT_FOUND",
      "That bank is no longer configured in Company Details.",
    );
  }
  return bank;
}

// ─── Ledger ───────────────────────────────────────────────────────────────────
// Money entries carry the chosen bank as free text in entries.remarks (an entry
// has no bank foreign key). These are the remarks the transaction services write
// for things that are NOT a bank payment — excluded so an unmatched remark can be
// surfaced honestly as "Unassigned" instead of being mistaken for a bank.
const NON_BANK_REMARKS = [
  "Cash",
  "Discount",
  "Cash Purchase Charge",
  "Cash Sale Charge",
  "TDS Adjustment",
  "TCS Adjustment",
  "GST",
  "Round Off",
];

export type BankTxnDirection = "CREDIT" | "DEBIT";

export interface BankTransaction {
  id: string;
  // Bill this came from — null for a manual deposit/withdrawal/transfer.
  groupId: string | null;
  bankKey: string;
  bankName: string;
  date: string;
  createdAt: Date;
  // Bill type (PURCHASE, SALE, …) or manual kind (DEPOSIT, TRANSFER_OUT, …).
  type: string;
  billNo: number | null;
  entryNo: number | null;
  party: string;
  narration: string | null;
  bankLabel: string;
  direction: BankTxnDirection;
  amount: number;
  balance: number;
  isManual: boolean;
  createdBy: string | null;
}

export interface BankSummary extends BankAccountConfig {
  opening: number;
  totalDebit: number;
  totalCredit: number;
  closing: number;
}

const UNASSIGNED_KEY = "__unassigned__";

function matchBank(
  remark: string,
  banks: BankAccountConfig[],
): BankAccountConfig | null {
  const lower = remark.trim().toLowerCase();
  // 1) Exact label written by the dropdowns.
  const exact = banks.find((b) => b.label.toLowerCase() === lower);
  if (exact) return exact;
  // 2) Account number present anywhere in the remark (label format changed, or
  //    the remark was typed by hand).
  const byAccount = banks.find(
    (b) => b.accountNo.length >= 4 && lower.includes(b.accountNo.toLowerCase()),
  );
  if (byAccount) return byAccount;
  // 3) Bank name prefix — covers rows saved before A/C numbers were configured.
  const byName = banks.find((b) => lower.startsWith(b.bankName.toLowerCase()));
  return byName ?? null;
}

// Bank payments recorded inside purchase/sales/expense/labour/job-work bills.
async function loadBillTransactions(
  banks: BankAccountConfig[],
  input: BankLedgerInput,
): Promise<BankTransaction[]> {
  const conditions = [
    eq(entryGroups.is_deleted, false),
    eq(entries.item_id, SYSTEM_ITEMS.RUPEE_ITEM_ID),
    isNotNull(entries.remarks),
    ne(entries.remarks, ""),
    notInArray(entries.remarks, NON_BANK_REMARKS),
  ];
  if (input.from_date) conditions.push(gte(entryGroups.date, input.from_date));
  if (input.to_date) conditions.push(lte(entryGroups.date, input.to_date));

  const rows = await db
    .select({
      id: entries.id,
      groupId: entryGroups.id,
      date: entryGroups.date,
      createdAt: entries.created_at,
      type: entryGroups.type,
      billNo: entryGroups.bill_no,
      entryNo: entryGroups.entry_no,
      groupRemarks: entryGroups.remarks,
      partyName: accounts.name,
      remarks: entries.remarks,
      quantity: entries.quantity,
      toAccountId: entries.to_account_id,
    })
    .from(entries)
    .innerJoin(entryGroups, eq(entries.group_id, entryGroups.id))
    .innerJoin(accounts, eq(entryGroups.account_id, accounts.id))
    .where(and(...conditions));

  return rows.map((row) => {
    const matched = matchBank(row.remarks ?? "", banks);
    return {
      id: row.id,
      groupId: row.groupId,
      // An "Unassigned" bucket keeps bank payments whose remark no longer matches
      // any configured bank visible, instead of silently dropping money.
      bankKey: matched?.key ?? UNASSIGNED_KEY,
      bankName: matched?.bankName ?? "Unassigned",
      date: row.date,
      createdAt: row.createdAt,
      type: row.type,
      billNo: row.billNo,
      entryNo: row.entryNo,
      party: row.partyName,
      narration: row.groupRemarks,
      bankLabel: row.remarks ?? "",
      // Money into the shop is a deposit (CREDIT); money leaving the shop — a
      // purchase payment, an expense, a goldsmith payout — is a withdrawal (DEBIT).
      direction: (row.toAccountId === SYSTEM_ACCOUNTS.SHOP_ID
        ? "CREDIT"
        : "DEBIT") as BankTxnDirection,
      amount: Number.parseFloat(row.quantity || "0"),
      balance: 0,
      isManual: false,
      createdBy: null,
    };
  });
}

// Deposits, withdrawals and transfers entered on the Bank page.
async function loadManualTransactions(
  banks: BankAccountConfig[],
  input: BankLedgerInput,
): Promise<BankTransaction[]> {
  const conditions = [];
  if (input.from_date)
    conditions.push(gte(bankTransactions.date, input.from_date));
  if (input.to_date) conditions.push(lte(bankTransactions.date, input.to_date));

  const rows = await db
    .select()
    .from(bankTransactions)
    .where(conditions.length ? and(...conditions) : undefined);

  return rows.map((row) => {
    const bank = banks.find((b) => b.key === row.bank_key);
    return {
      id: row.id,
      groupId: null,
      bankKey: row.bank_key,
      // Fall back to the label snapshotted at entry time if the bank was since
      // renamed or removed in Company Details.
      bankName: bank?.bankName ?? row.bank_label,
      date: row.date,
      createdAt: row.created_at,
      type: row.kind,
      billNo: null,
      entryNo: null,
      party: row.counterparty_bank_label ?? "—",
      narration: row.remarks,
      bankLabel: row.bank_label,
      direction: row.direction as BankTxnDirection,
      amount: Number.parseFloat(row.amount || "0"),
      balance: 0,
      isManual: true,
      createdBy: row.created_by,
    };
  });
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function getBankLedger(input: BankLedgerInput) {
  const banks = await listBanks();

  const [billTxns, manualTxns] = await Promise.all([
    loadBillTransactions(banks, input),
    loadManualTransactions(banks, input),
  ]);

  let all = [...billTxns, ...manualTxns];
  if (input.bankKey) all = all.filter((t) => t.bankKey === input.bankKey);

  // Oldest first so each bank's running balance builds forward from its opening.
  all.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });

  const summaries = new Map<string, BankSummary>();
  const ensureSummary = (txn: BankTransaction): BankSummary => {
    let s = summaries.get(txn.bankKey);
    if (!s) {
      const cfg = banks.find((b) => b.key === txn.bankKey);
      s = {
        key: txn.bankKey,
        bankName: cfg?.bankName ?? txn.bankName,
        accountNo: cfg?.accountNo ?? "",
        ifscCode: cfg?.ifscCode ?? "",
        branch: cfg?.branch ?? "",
        openingBalance: cfg?.openingBalance ?? "0",
        label: cfg?.label ?? txn.bankLabel,
        opening: Number.parseFloat(cfg?.openingBalance ?? "0") || 0,
        totalDebit: 0,
        totalCredit: 0,
        closing: 0,
      };
      summaries.set(txn.bankKey, s);
    }
    return s;
  };

  // Every configured bank appears even when it has no activity yet.
  for (const b of banks) {
    if (input.bankKey && b.key !== input.bankKey) continue;
    summaries.set(b.key, {
      ...b,
      opening: Number.parseFloat(b.openingBalance) || 0,
      totalDebit: 0,
      totalCredit: 0,
      closing: 0,
    });
  }

  const running = new Map<string, number>();
  for (const txn of all) {
    const summary = ensureSummary(txn);
    const prev = running.get(txn.bankKey) ?? summary.opening;
    const next = txn.direction === "CREDIT" ? prev + txn.amount : prev - txn.amount;
    running.set(txn.bankKey, next);
    txn.balance = round2(next);

    if (txn.direction === "CREDIT") summary.totalCredit += txn.amount;
    else summary.totalDebit += txn.amount;
  }

  for (const summary of summaries.values()) {
    summary.totalCredit = round2(summary.totalCredit);
    summary.totalDebit = round2(summary.totalDebit);
    summary.closing = round2(running.get(summary.key) ?? summary.opening);
  }

  const summaryList = Array.from(summaries.values()).filter(
    // Drop the Unassigned bucket unless something actually landed in it.
    (s) =>
      s.key !== UNASSIGNED_KEY ||
      all.some((t) => t.bankKey === UNASSIGNED_KEY),
  );

  // The log reads newest first; the balance column still carries the
  // chronological running balance computed above.
  const log = [...all].reverse();
  const total = log.length;
  const totalPages = Math.max(1, Math.ceil(total / input.limit));
  const page = Math.min(input.page, totalPages);
  const start = (page - 1) * input.limit;

  return {
    banks: summaryList,
    grandTotals: {
      opening: round2(summaryList.reduce((s, l) => s + l.opening, 0)),
      debit: round2(summaryList.reduce((s, l) => s + l.totalDebit, 0)),
      credit: round2(summaryList.reduce((s, l) => s + l.totalCredit, 0)),
      closing: round2(summaryList.reduce((s, l) => s + l.closing, 0)),
    },
    log: {
      rows: log.slice(start, start + input.limit),
      page,
      limit: input.limit,
      total,
      totalPages,
    },
  };
}

// ─── Manual money movements ───────────────────────────────────────────────────

export async function addBankFunds(
  input: AddBankFundsInput,
  user?: { username: string } | null,
) {
  const bank = await requireBank(input.bankKey);

  const [row] = await db
    .insert(bankTransactions)
    .values({
      bank_key: bank.key,
      bank_label: bank.label,
      kind: input.direction === "CREDIT" ? "DEPOSIT" : "WITHDRAWAL",
      direction: input.direction,
      amount: input.amount,
      date: input.date,
      remarks: input.remarks?.trim() || null,
      created_by: user?.username ?? null,
    })
    .returning();

  return row!;
}

export async function transferBankFunds(
  input: TransferBankFundsInput,
  user?: { username: string } | null,
) {
  const [fromBank, toBank] = await Promise.all([
    requireBank(input.fromBankKey),
    requireBank(input.toBankKey),
  ]);

  // Both legs are written in one transaction — a transfer must never end up
  // recorded on only one side of the move.
  return db.transaction(async (tx) => {
    const transferGroupId = crypto.randomUUID();
    const common = {
      amount: input.amount,
      date: input.date,
      remarks: input.remarks?.trim() || null,
      transfer_group_id: transferGroupId,
      created_by: user?.username ?? null,
    };

    const rows = await tx
      .insert(bankTransactions)
      .values([
        {
          ...common,
          bank_key: fromBank.key,
          bank_label: fromBank.label,
          kind: "TRANSFER_OUT" as const,
          direction: "DEBIT" as const,
          counterparty_bank_key: toBank.key,
          counterparty_bank_label: toBank.label,
        },
        {
          ...common,
          bank_key: toBank.key,
          bank_label: toBank.label,
          kind: "TRANSFER_IN" as const,
          direction: "CREDIT" as const,
          counterparty_bank_key: fromBank.key,
          counterparty_bank_label: fromBank.label,
        },
      ])
      .returning();

    return { transferGroupId, rows };
  });
}
