# Gold Billing & Manufacturing System — Backend Handover Guide

> Written for handover. Plain language, no accounting knowledge required. Read top to bottom before touching any code.

---

## Table of Contents

1. [What This System Does](#1-what-this-system-does)
2. [Tech Stack](#2-tech-stack)
3. [The Core Concept — Double-Entry Accounting](#3-the-core-concept--double-entry-accounting)
4. [Database Tables](#4-database-tables)
5. [Core Calculations](#5-core-calculations)
6. [How Balances Are Calculated](#6-how-balances-are-calculated)
7. [Every Transaction Type Explained](#7-every-transaction-type-explained)
8. [How Edit and Delete Work](#8-how-edit-and-delete-work)
9. [System Accounts and Items](#9-system-accounts-and-items)
10. [Auto-Generated Numbers](#10-auto-generated-numbers)
11. [The API Layer (tRPC)](#11-the-api-layer-trpc)
12. [File Reference](#12-file-reference)
13. [Rules You Must Never Break](#13-rules-you-must-never-break)

---

## 1. What This System Does

This is the backend for a **gold jewelry shop**. It handles:

- Buying raw gold from suppliers (**Purchase**)
- Selling finished jewelry to customers (**Sale**)
- Sending gold to goldsmiths for manufacturing (**Job Work**)
- Receiving goldsmith labor bills (**Labour Bill**)
- Recording shop expenses (**Expense**)
- Tracking all gold stock and cash balances in real time

The entire system is built on one principle: **every gram of gold and every rupee is tracked through a ledger, always.**

---

## 2. Tech Stack

| Layer | Tool | Why |
|-------|------|-----|
| Language | Node.js + TypeScript | Server side |
| API | tRPC | Type-safe frontend↔backend calls |
| Database | PostgreSQL | Stores everything |
| ORM | Drizzle ORM | TypeScript → SQL |
| Math | `decimal.js` | No floating point errors |
| HTTP | Express | Hosts the tRPC server |

> **Why `decimal.js`?** In JavaScript, `0.1 + 0.2 = 0.30000000000000004`. For gold weights and money, even a 0.000001g error is a real problem. `decimal.js` avoids this entirely.

---

## 3. The Core Concept — Double-Entry Accounting

**This is the most important thing to understand. Get this right and everything else makes sense.**

### The rule:

No balance is ever stored in the database. Instead, every transaction records:
- **Who/what sent** the gold or cash (`from_account_id`)
- **Who/what received** the gold or cash (`to_account_id`)

The balance of any account is always calculated live:

```
Balance = Total Received (Inflows) − Total Sent (Outflows)
```

### Real Example — Purchase:

Varun brings **100g of 22KT gold**. The shop pays him **₹50,000** advance.

Two ledger entries are written:

| # | From | To | What | Amount |
|---|------|----|------|--------|
| 1 | Varun | Shop | 22KT Gold | 100g |
| 2 | Shop | Varun | Rupee | ₹50,000 |

**Varun's gold balance:**
- Received: 0g
- Sent: 100g
- Balance = 0 − 100 = **−100g**

*Negative means: the shop is holding Varun's gold. The shop owes him that metal.*

**Varun's cash balance:**
- Received: ₹50,000
- Sent: ₹0
- Balance = ₹50,000 − 0 = **+₹50,000**

*Positive means: Varun is holding the shop's cash advance.*

> The negative pure balance is **not a bug**. In jewelry accounting, a negative metal balance for a supplier = the shop owes them that gold. A positive cash balance = an advance has been paid. This is correct and standard.

---

## 4. Database Tables

All schemas are in `server/src/db/schema/`.

---

### `accounts` — Everyone who holds gold or cash

| Column | Description |
|--------|-------------|
| `id` | UUID, primary key |
| `entry_no` | Auto-incremented human-readable number |
| `name` | e.g. "Varun Traders" |
| `type` | `SHOP`, `CUSTOMER`, `GOLDSMITH`, `CASH`, `BANK`, `EXPENSE`, `LOSS`, `OPENING_STOCK` |
| `customer_type` | `PURCHASER`, `CUSTOMER`, `GOLD_SMITH`, `SALES_MAN`, `LABOUR_BILL` |
| `opening_pure_balance` | ⚠️ Reference only — NOT used for live balance |
| `opening_cash_balance` | ⚠️ Reference only — NOT used for live balance |
| `is_system_account` | If `true`, cannot be deleted |
| `is_deleted` | Soft delete (never truly erased) |

> The opening balance fields are just reference numbers entered when the account was created. When an account is created with an opening balance, the system creates an **OPENING ledger entry** automatically. The live balance always comes from reading the `entries` table, never from these fields.

---

### `items` — What can be transferred: gold types, ornament types, and rupees

| Column | Description |
|--------|-------------|
| `name` | e.g. "22KT Gold", "Necklace", "Rupee" |
| `type` | `GOLD`, `ORNAMENT`, `MONEY` |
| `unit` | `GRAM`, `PIECE`, `RUPEE` |

There is exactly **one MONEY item** in the whole system: the Rupee. All cash transactions use this single item.

---

### `entry_groups` — The bill/voucher header for every transaction

| Column | Description |
|--------|-------------|
| `entry_no` | Unique sequential number across all transactions |
| `bill_no` | Sequential per account per type (Varun's 5th purchase = bill_no 5) |
| `date` | Bill date (YYYY-MM-DD) |
| `type` | `PURCHASE`, `SALE`, `JOB_WORK`, `LABOUR_BILL`, `EXPENSE`, `OPENING`, `REVERSAL` |
| `account_id` | The main account (e.g. Varun for a purchase) |
| `rate_per_gram` | Gold rate that day — stored for reference |
| `reversed_by` | Points to the REVERSAL group if this was cancelled |
| `reversal_of` | Points to the original group if this IS a reversal |
| `is_deleted` | Soft delete |

---

### `entries` — Every individual money/gold movement ⚠️ INSERT-ONLY

> **CRITICAL: This table is never updated or deleted. Every write to this table is permanent and forever.**

| Column | Description |
|--------|-------------|
| `group_id` | Links to `entry_groups.id` |
| `lot_id` | e.g. `LOT-0001` — tracks a physical batch of gold |
| `from_account_id` | Who sent the item |
| `to_account_id` | Who received the item |
| `item_id` | What was sent (gold type, ornament, rupee) |
| `quantity` | How much (grams / pieces / rupees) |
| `purity` | Touch % e.g. 91.6 for 22KT |
| `pure_quantity` | **Auto-calculated**: `quantity × purity / 100` |
| `wastage_mode` | `PERCENT` or `GRAM` |
| `wastage_value` | The wastage % or gram fee |
| `wastage_quantity` | **Auto-calculated** wastage in grams |
| `rate` | Price per gram |
| `amount` | Cash value (`quantity × rate`) |

**All balances, stock levels, and history are derived by running SUM queries on this table.**

---

## 5. Core Calculations

All math is in `server/src/lib/decimal.ts`. Always use these functions, never raw JavaScript math.

---

### Pure Gold Weight (Most Important)

Gold is not 100% pure. The "touch" or purity % tells you how much actual gold is in a given weight:
- 24KT = 99.9% pure
- 22KT = 91.6% pure
- 18KT = 75.0% pure

```
Pure Quantity = Gross Weight × (Purity ÷ 100)

Example: 100g of 22KT gold
= 100 × (91.6 ÷ 100) = 91.6g pure gold
```

This is calculated **automatically** inside `createEntryGroup()`. You never calculate it manually.

---

### Wastage (Job Work / Manufacturing)

Some gold is lost when making jewelry (burnt in melting, dust, filings). This loss is called **wastage**. Two modes:

**Mode A — Wastage by Percentage:**
```
Wastage = Base Weight × (Wastage% ÷ Touch%)

Example: 100g at 91.6% touch, charged 2% wastage
= 100 × (2 ÷ 91.6) = 2.18g
```

**Mode B — Wastage Flat per Gram:**
```
Wastage = Base Weight × Wastage amount per gram

Example: 100g gold, goldsmith charges 0.5g per gram
= 100 × 0.5 = 50g
```

---

### Cash Amount

```
Amount (₹) = Quantity (grams) × Rate per gram

Example: 91.6g pure gold at ₹6,500/gram
= 91.6 × 6,500 = ₹5,95,400
```

---

### Total Weight (with deductions)

For ornaments with non-gold parts (stones, screws):
```
Total Weight = Gross Weight − Stone − Throde + Wastage
```

---

## 6. How Balances Are Calculated

All balance logic is in `server/src/lib/balance.ts`. **Balances are never stored — always calculated live.**

---

### `getBalance(accountId, itemId)`

Balance for a single account and a single item:

```sql
Inflows  = SUM(quantity) WHERE to_account_id   = accountId AND item_id = itemId
Outflows = SUM(quantity) WHERE from_account_id = accountId AND item_id = itemId
Balance  = Inflows − Outflows
```

---

### `getAggregateBalances(accountId, asOfDate?, excludeGroupId?)`

Returns two values at once — used for the Purchase form opening balances and history table:

**Total Pure Balance** (all gold + ornaments combined):
```sql
= SUM(pure_quantity WHERE to_account   = account)   -- all gold received
− SUM(pure_quantity WHERE from_account = account)   -- all gold sent out
```

**Total Cash Balance** (rupees only):
```sql
= SUM(quantity WHERE to_account   = account AND item = RUPEE)   -- cash received
− SUM(quantity WHERE from_account = account AND item = RUPEE)   -- cash paid
```

**Optional parameters:**

| Parameter | What it does |
|-----------|-------------|
| `asOfDate` | Only counts entries up to this exact date/time. Used to get the balance *before* a specific transaction (the opening balance for a bill). |
| `excludeGroupId` | Ignores all entries in this transaction group. Used during editing so the form shows the balance as if the bill being edited doesn't exist yet. |

---

### How Opening Balance in the History Table is Calculated

For every row in the Purchase History, the Opening Balance columns are:

```
Opening Balance for Bill X =
  getAggregateBalances(
    accountId      = bill's account,
    asOfDate       = timestamp of this bill,  ← rewind the ledger to just before
    excludeGroupId = this bill's own ID       ← exclude this bill's own entries
  )
```

**Result:** "What was Varun's exact balance the moment before this specific purchase was recorded?"

For the very first transaction ever, this returns 0 — nothing existed before it.

---

### `getLotBalances(accountId, itemId)`

Returns all unconsumed gold batches (`LOT-XXXX`) for an account — used in the stock view to show what's physically on hand and where.

---

## 7. Every Transaction Type Explained

All writes go through **`createEntryGroup()`** in `server/src/lib/entryBuilder.ts`.

---

### PURCHASE — Shop buys gold from a supplier

**Scenario:** Varun brings 100g of 22KT gold. Shop pays ₹50,000 advance.

**Entries created:**

| From | To | Item | Qty | Pure Qty | Lot |
|------|----|------|-----|----------|-----|
| Varun | Shop | 22KT Gold | 100g | 91.6g | LOT-0001 |
| Shop | Varun | Rupee | ₹50,000 | — | — |

**Effect:**
- Varun's pure balance: **−91.6g** (shop holds his gold)
- Varun's cash balance: **+₹50,000** (he holds the advance)
- Shop stock: **+91.6g**

A `LOT-XXXX` is auto-generated for the gold entry to track this physical batch.

---

### SALE — Shop sells jewelry to a customer

**Scenario:** Customer buys a necklace (20g, 22KT). Pays ₹1,30,000 in full.

| From | To | Item | Qty |
|------|----|------|-----|
| Shop | Customer | Necklace | 1 piece |
| Customer | Shop | Rupee | ₹1,30,000 |

---

### JOB WORK — Shop sends gold to a goldsmith for manufacturing

**Scenario:** Shop sends 50g of gold to goldsmith to make bangles.

| From | To | Item | Qty | Lot |
|------|----|------|-----|-----|
| Shop | Goldsmith | Gold | 50g | LOT-0005 |

Goldsmith now "holds" this gold and is accountable for it. When they return finished ornaments, a LABOUR BILL closes this out.

---

### LABOUR BILL — Goldsmith returns ornaments and charges for work

**Scenario:** Goldsmith returns 12 bangles. Charges 3g wastage + ₹5,000 labor.

| From | To | Item | Qty |
|------|----|------|-----|
| Goldsmith | Shop | Bangles | 12 pieces |
| Shop | Goldsmith | Rupee | ₹5,000 |
| Shop | LOSS Account | Gold | 3g (wastage) |

---

### OPENING — Set starting balance for a new account

Created automatically when an account is made with a non-zero opening balance.

| From | To | Item | Qty |
|------|----|------|-----|
| Shop | Varun | Rupee | ₹10,000 |

---

### EXPENSE — Shop pays a bill

**Scenario:** Shop pays ₹2,000 rent.

| From | To | Item | Qty |
|------|----|------|-----|
| Shop | EXPENSE Account | Rupee | ₹2,000 |

---

### REVERSAL — Auto-created by the system on Edit or Delete

See Section 8.

---

## 8. How Edit and Delete Work

Location: `server/src/lib/reversal.ts`

**The `entries` table is insert-only.** Nothing is ever corrected in-place. Instead:

### The Reversal Process (automatic, step by step):

1. Fetch the original `entry_group` and all its entries.
2. Create a **new REVERSAL entry_group** with all the same entries but **`from` and `to` are swapped on every line**. This cancels the original exactly.
3. Mark the original as soft-deleted (`is_deleted = true`). Hidden from UI.
4. Link them: `original.reversed_by = reversal.id` and `reversal.reversal_of = original.id`.
5. **(Edit only)** Create a brand new transaction with the corrected values.

### Why swapping from/to cancels it out:

**Original:** Varun → Shop (100g gold) → net effect: Shop +100g, Varun −100g

**Reversal:** Shop → Varun (100g gold) → net effect: Shop −100g, Varun +100g

Combined: zero. The original transaction is completely undone from a balance perspective, yet every record stays in the database for audit.

---

## 9. System Accounts and Items

Location: `server/src/config/constants.ts`

These have **fixed hardcoded UUIDs** — identical in every environment.

```
SYSTEM_ACCOUNTS:
  SHOP_ID           = "00000000-0000-0000-0000-000000000001"
  CASH_ID           = "00000000-0000-0000-0000-000000000002"
  BANK_ID           = "00000000-0000-0000-0000-000000000003"
  LOSS_ID           = "00000000-0000-0000-0000-000000000004"
  EXPENSE_ID        = "00000000-0000-0000-0000-000000000005"
  OPENING_STOCK_ID  = "00000000-0000-0000-0000-000000000006"

SYSTEM_ITEMS:
  RUPEE_ITEM_ID     = "00000000-0000-0000-0000-000000000010"
```

> Do not change these UUIDs. They must match what `server/src/db/seed.ts` inserts on first setup.

---

## 10. Auto-Generated Numbers

Location: `server/src/lib/entryNoGenerator.ts`

### `entry_no`
Sequential human-readable number, unique per table. Generated inside a DB transaction to avoid duplicates.
```
Next = MAX(existing entry_no) + 1
```

### `bill_no`
Sequential per account per transaction type. Varun and Customer X both have their own `bill_no` counters.
```
Next = MAX(bill_no WHERE account = X AND type = Y) + 1
```

### `lot_id`
Format: `LOT-0001`, `LOT-0002`, etc.

Auto-assigned when a `GOLD` or `ORNAMENT` item flows **into** a `SHOP` or `GOLDSMITH` account.

Not assigned for: cash entries, gold flowing out to customers.

---

## 11. The API Layer (tRPC)

Location: `server/src/app.router.ts`

tRPC lets the frontend call backend functions like plain JavaScript — no REST, no JSON parsing, fully typed.

```
system.ping                          → Health check

items.list / create / update / delete

accounts.list / create / update / delete
accounts.getBalance                  → Live balance for one item
accounts.getAggregateBalances        → Live pure + cash totals (supports asOfDate, excludeGroupId)

transactions.purchase.list           → Paginated history with entries + opening balances
transactions.purchase.getById        → Full details for editing
transactions.purchase.create
transactions.purchase.update         → Reversal + new transaction
transactions.purchase.delete         → Reversal only

transactions.sales         (same structure)
transactions.jobWork       (same structure)
transactions.labourBill    (same structure)
transactions.expense       (same structure)

stock.list                           → Current stock by LOT-XXXX
dashboard.summary                    → Aggregated totals
settings / notifications
```

---

## 12. File Reference

### `server/src/lib/` — Core business logic

| File | Purpose |
|------|---------|
| `balance.ts` | All balance calculations — read this first |
| `decimal.ts` | All gold/money math functions |
| `entryBuilder.ts` | The only function that writes to the DB (`createEntryGroup`) |
| `reversal.ts` | Edit and delete via entry reversal |
| `entryNoGenerator.ts` | entry_no and lot_id generation |
| `transactionQueries.ts` | Shared list and getById queries |
| `trpc.ts` | tRPC setup |
| `context.ts` | Auth context per request |
| `permissions.ts` | Access control |

### `server/src/db/schema/` — Table definitions

| File | Table |
|------|-------|
| `accounts.ts` | `accounts` |
| `items.ts` | `items` |
| `entry-groups.ts` | `entry_groups` |
| `entries.ts` | `entries` (insert-only) |
| `settings.ts` | `settings` |
| `notifications.ts` | `notifications` |

### `server/src/modules/` — Feature modules

Each module has: `router.ts` (API endpoints) → `service.ts` (logic) → `schema.ts` (validation).

Modules: `accounts`, `items`, `auth`, `dashboard`, `stock`, `settings`, `notifications`, `transactions/purchase`, `transactions/sales`, `transactions/jobWork`, `transactions/labourBill`, `transactions/expense`.

---

## 13. Rules You Must Never Break

---

### ❌ Never store a balance in a column

No `current_balance` columns ever. Always calculate via `getBalance()` or `getAggregateBalances()`. Stored balances go out of sync immediately.

---

### ❌ Never UPDATE or DELETE from the `entries` table

It is a permanent audit ledger. To correct a transaction, use `reverseEntryGroup()`. Direct edits corrupt all historical balance calculations forever.

---

### ❌ Never use JavaScript math for gold or money

```typescript
// ✅ Correct
import { calcPure } from "@/lib/decimal";
calcPure("100", "91.6")  // → exactly 91.6

// ❌ Wrong
(100 * 91.6) / 100  // → 91.60000000000001
```

---

### ❌ Never hardcode system UUIDs in service files

```typescript
// ✅ Correct
import { SYSTEM_ACCOUNTS, SYSTEM_ITEMS } from "@/config/constants";
fromAccountId: SYSTEM_ACCOUNTS.SHOP_ID

// ❌ Wrong
fromAccountId: "00000000-0000-0000-0000-000000000001"
```

---

### ❌ Never set `lot_id` manually on a new entry

It is auto-generated inside `createEntryGroup()`. Only pass `lotId` when re-creating an existing entry during a reversal/edit scenario.

---

### ❌ Never use `bill_no` as a unique transaction ID

Bill numbers repeat per account. Always use the UUID `id` from `entry_groups` for unique references.

---

### ✅ Always go through `createEntryGroup()` for all writes

It guarantees:
- Atomic PostgreSQL transaction (roll back everything on failure)
- Auto lot ID generation
- Auto `pure_quantity` calculation
- Auto `wastage_quantity` calculation
- Safe `entry_no` generation

---

## Architecture Summary

```
Frontend (React)
    │
    │ tRPC call (type-safe)
    ▼
router.ts  ──  Zod input validation
    │
service.ts  ──  business rules
    │
    ├──────────────────────────────────┐
    │                                  │
    ▼                                  ▼
createEntryGroup()          getAggregateBalances()
     │                               │
  WRITES:                         READS:
  entry_groups (INSERT)            entries table
  entries (INSERT ONLY)           SUM(inflows) − SUM(outflows)
    │                                  │
    └──────────────────────────────────┘
                  │
            PostgreSQL
      (single source of truth)
```

---

*Last updated: April 2026. Update this document whenever the accounting model, transaction types, or balance logic changes.*
