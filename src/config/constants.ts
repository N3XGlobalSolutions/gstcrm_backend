/**
 * System account and item IDs — populated by the seed script.
 * These constants are used throughout service layer to reference
 * well-known system entries without DB lookups.
 *
 * IMPORTANT: These values MUST match what the seed script inserts.
 * They are deterministic UUIDs so they remain stable across environments.
 */

// Deterministic UUIDs for system accounts (stable across envs)
export const SYSTEM_ACCOUNTS = {
  SHOP_ID: "00000000-0000-0000-0000-000000000001",
  CASH_ID: "00000000-0000-0000-0000-000000000002",
  BANK_ID: "00000000-0000-0000-0000-000000000003",
  LOSS_ID: "00000000-0000-0000-0000-000000000004",
  EXPENSE_ID: "00000000-0000-0000-0000-000000000005",
  OPENING_STOCK_ID: "00000000-0000-0000-0000-000000000006",
} as const;

// Deterministic UUID for the system RUPEE item
export const SYSTEM_ITEMS = {
  RUPEE_ITEM_ID: "00000000-0000-0000-0000-000000000010",
} as const;
