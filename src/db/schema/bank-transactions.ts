import {
  pgTable,
  uuid,
  text,
  date,
  timestamp,
  numeric,
  varchar,
  pgEnum,
  index,
} from "drizzle-orm/pg-core";

// ─── Enums ────────────────────────────────────────────────────────────────────

export const bankTxnDirectionEnum = pgEnum("bank_txn_direction", [
  "CREDIT",
  "DEBIT",
]);

export const bankTxnKindEnum = pgEnum("bank_txn_kind", [
  "DEPOSIT", // Money added to a bank by hand
  "WITHDRAWAL", // Money taken out of a bank by hand
  "TRANSFER_IN", // Receiving leg of a bank → bank transfer
  "TRANSFER_OUT", // Sending leg of a bank → bank transfer
]);

// ─── bank_transactions ────────────────────────────────────────────────────────
// Manual bank money movements — deposits, withdrawals and bank → bank transfers
// entered on the Bank page. These are deliberately NOT written into `entries`:
// the entries ledger models gold/money moving between the shop and a party, and
// a transfer between the shop's own two banks has no such party. Bank-derived
// rows from `entries` (purchase/sales/expense payments) and these rows are
// merged at read time by the bank service.
//
// Like `entries`, this table is append-only: the log always shows what was
// actually done and when.

export const bankTransactions = pgTable(
  "bank_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Bank identity — key is `${bankName}|${accountNo}` lowercased, matching
    // buildBankKey() in the bank service. The label is snapshotted so the log
    // still reads correctly if the bank is later renamed in Company Details.
    bank_key: varchar("bank_key", { length: 400 }).notNull(),
    bank_label: varchar("bank_label", { length: 400 }).notNull(),
    kind: bankTxnKindEnum("kind").notNull(),
    direction: bankTxnDirectionEnum("direction").notNull(),
    amount: numeric("amount", { precision: 20, scale: 2 }).notNull(),
    date: date("date").notNull(),
    remarks: text("remarks"),
    // Both legs of one transfer share this id, so the pair can never be read apart.
    transfer_group_id: uuid("transfer_group_id"),
    // The other bank in a transfer (null for deposits/withdrawals).
    counterparty_bank_key: varchar("counterparty_bank_key", { length: 400 }),
    counterparty_bank_label: varchar("counterparty_bank_label", { length: 400 }),
    // Audit
    created_by: varchar("created_by", { length: 200 }),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("bank_transactions_bank_key_idx").on(t.bank_key),
    index("bank_transactions_date_idx").on(t.date),
    index("bank_transactions_transfer_group_idx").on(t.transfer_group_id),
  ],
);
