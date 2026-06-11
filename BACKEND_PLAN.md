# Gold Billing & Manufacturing System — Complete Backend Plan (Double-Entry Ledger Architecture)

---

## 1. Core Concept

Everything in this system is a **movement of value between two parties**.

Instead of updating a stock number when a purchase happens, the system records:

> "X grams of gold moved FROM the customer TO the shop"

Stock, balances, and all metrics are always **calculated** from these movements — never stored as a mutable number.

This means:

- Nothing is ever edited or deleted — only reversed
- The full history of every gram of gold is always available
- Bugs like negative stock or balance mismatch become structurally impossible

---

## 2. Technology Stack

| Layer      | Technology                    |
| ---------- | ----------------------------- |
| Runtime    | Bun                           |
| Framework  | Express                       |
| API Layer  | Trpc                          |
| Database   | PostgreSQL                    |
| ORM        | Drizzle ORM                   |
| Validation | Zod                           |
| Auth       | JWT (jsonwebtoken + bcryptjs) |
| Precision  | decimal.js                    |

---

## 3. Folder Structure

```
/src
  /config        — env, jwt config, constants
  /db
    /schema      — one file per domain
    /migrations
    index.ts
  /modules
    /auth
    /items
    /accounts
    /ledger
    /transactions
      /purchase
      /sales
      /labour-bill
      /job-work
    /dashboard
    /notifications
    /expense
    /stock
    /settings
      /users
      /permissions
      /company
      /backup
  /middleware    — auth guard, permission check, error handler
  /lib           — decimal, balance, entryBuilder, reversal, entryNo
  /types         — shared types, enums
  app.ts
  index.ts
```

Each module follows:

```
/module-name
  schema.ts   — Zod input schemas
  router.ts   — trpc procedures
  service.ts  — business logic and calculations
  queries.ts  — Drizzle DB queries only
```

---

## 4. Core Architecture Principles

**A. Immutable Ledger**
Entries are never updated or deleted. Corrections are done via reversal entry groups that swap from/to accounts.

**B. Decimal Precision**

- All quantities: `NUMERIC(20,8)` in PostgreSQL
- All monetary values: `NUMERIC(20,2)` in PostgreSQL
- All calculations: `decimal.js` in application code
- Never use JS native `+`, `-`, `*`, `/` on gold weights or financial values
- Serialize decimal.js results to string before DB write

**C. Soft Deletes**
Every table except `entries` has `is_deleted: boolean DEFAULT false`. The `entries` table has no delete at all — not even soft delete.

**D. Atomic Writes**
Every `createEntryGroup` call runs inside a single PostgreSQL transaction. If any entry insert fails, the entire group rolls back.

**E. Single Source of Truth**
Stock, balances, and all financial positions are always derived from the `entries` table using `getBalance`. Nothing is stored as a running total anywhere.

---

## 5. Database Schema

### 5.1 `items`

Everything that can move — gold types, ornament types, money.

- `id` — uuid, primary key
- `entry_no` — integer, unique
- `name` — varchar(100), unique within type, not null
- `type` — pgEnum: `GOLD | ORNAMENT | MONEY`
- `unit` — pgEnum: `GRAM | PIECE | RUPEE`
- `is_deleted` — boolean, default false
- `created_at`, `updated_at` — timestamp

---

### 5.2 `accounts`

Everyone and everything that can hold value.

- `id` — uuid, primary key
- `entry_no` — integer, unique
- `name` — varchar(200), not null
- `type` — pgEnum: `SHOP | CUSTOMER | GOLDSMITH | CASH | BANK | EXPENSE | LOSS`
- `customer_type` — pgEnum: `PURCHASER | CUSTOMER | GOLD_SMITH | SALES_MAN | LABOUR_BILL` nullable
- `gst_no` — varchar(20), nullable
- `pan_no` — varchar(10), nullable
- `state_code` — varchar(10), nullable
- `place_of_supply` — varchar(100), nullable
- `address` — text, nullable
- `phone` — varchar(15), nullable
- `email` — varchar(200), nullable
- `website` — varchar(200), nullable
- `opening_pure_balance` — NUMERIC(20,8), default 0
- `opening_cash_balance` — NUMERIC(20,2), default 0
- `is_system_account` — boolean, default false — system accounts cannot be deleted
- `is_deleted` — boolean, default false
- `created_at`, `updated_at` — timestamp

---

### 5.3 `entry_groups`

One row per business transaction.

- `id` — uuid, primary key
- `entry_no` — integer, unique
- `bill_no` — integer, nullable (per account sequence)
- `date` — date, not null
- `type` — pgEnum: `PURCHASE | SALE | JOB_WORK | LABOUR_BILL | EXPENSE | OPENING | REVERSAL`
- `account_id` — uuid → FK accounts.id (primary counterparty)
- `rate_per_gram` — NUMERIC(20,2), nullable
- `remarks` — text, nullable
- `reversed_by` — uuid → FK entry_groups.id, nullable
- `reversal_of` — uuid → FK entry_groups.id, nullable
- `is_deleted` — boolean, default false
- `created_at`, `updated_at` — timestamp

---

### 5.4 `entries`

The core ledger. Every single movement of value. Never updated or deleted.

- `id` — uuid, primary key
- `group_id` — uuid → FK entry_groups.id, not null
- `from_account_id` — uuid → FK accounts.id, not null
- `to_account_id` — uuid → FK accounts.id, not null
- `item_id` — uuid → FK items.id, not null
- `quantity` — NUMERIC(20,8), not null
- `purity` — NUMERIC(20,8), nullable — touch percentage
- `pure_quantity` — NUMERIC(20,8), nullable — quantity × (purity/100), computed before insert
- `wastage_mode` — pgEnum: `PERCENT | GRAM`, nullable
- `wastage_value` — NUMERIC(20,8), nullable — input wastage percent or gram value
- `wastage_quantity` — NUMERIC(20,8), nullable — computed wastage in grams
- `rate` — NUMERIC(20,2), nullable
- `amount` — NUMERIC(20,2), nullable
- `remarks` — text, nullable
- `created_at` — timestamp

No `is_deleted` on this table. No update ever. Insert only.

---

### 5.5 `users`

- `id` — uuid, primary key
- `entry_no` — integer, unique
- `username` — varchar, unique, not null
- `password_hash` — text, not null
- `user_group` — varchar
- `is_deleted` — boolean, default false
- `created_at`, `updated_at`

---

### 5.6 `user_form_permissions`

- `id` — uuid, primary key
- `user_id` — uuid → FK users.id
- `module` — varchar
- `form_name` — varchar
- `allowed` — boolean

---

### 5.7 `user_activity_permissions`

- `id` — uuid, primary key
- `user_id` — uuid → FK users.id
- `can_view` — boolean
- `can_edit` — boolean
- `can_delete` — boolean

---

### 5.8 `notifications`

- `id` — uuid, primary key
- `entry_no` — integer, unique
- `message` — text, not null
- `created_by` — uuid → FK users.id
- `is_deleted` — boolean, default false
- `created_at`

---

### 5.9 `print_templates`

- `id` — uuid, primary key
- `entry_no` — integer, unique
- `template_name` — varchar
- `status` — boolean, default true
- `created_at`

---

### 5.10 `company_details`

- `id` — uuid, primary key (single row)
- `company_name` — varchar
- `address` — text
- `phone` — varchar
- `email` — varchar
- `gst_no` — varchar
- `pan_no` — varchar
- `bank_details` — text
- `logo_url` — varchar
- `updated_at` — timestamp

---

## 6. Indexes

```
entries(group_id)
entries(from_account_id, item_id)
entries(to_account_id, item_id)
entries(from_account_id, item_id, created_at)
entries(to_account_id, item_id, created_at)
entry_groups(account_id, type, is_deleted)
entry_groups(date, type, is_deleted)
entry_groups(type, is_deleted)
accounts(type, is_deleted)
accounts(customer_type, is_deleted)
items(type, is_deleted)
```

---

## 7. Database Constraints

- `items(name, type)` — unique together (same name allowed across different types)
- `users(username)` — unique
- `entries` — no DELETE permission at DB level (enforce via DB role)
- `accounts` where `is_system_account = true` — block deletion via application layer
- All direction/type enums enforced via pgEnum at DB level

---

## 8. Seed Data (Required Before Any Module Works)

The seed script at `/src/db/seed.ts` must create:

**System accounts (is_system_account = true):**

- SHOP account — type: SHOP, name: "Shop"
- CASH account — type: CASH, name: "Cash"
- BANK account — type: BANK, name: "Bank"
- LOSS account — type: LOSS, name: "Loss / Wastage"
- EXPENSE account — type: EXPENSE, name: "General Expense"

**System items:**

- RUPEE item — type: MONEY, unit: RUPEE, name: "Rupee"

**Admin user:**

- username: `admin`, password: `Admin@123` (bcrypt hashed)
- Full form permissions for all modules
- `can_view: true`, `can_edit: true`, `can_delete: true`

**Company details:**

- One placeholder row

Store the IDs of system accounts and the RUPEE item as constants in `/src/config/constants.ts` — exported as `SYSTEM_ACCOUNTS` and `SYSTEM_ITEMS`. These constants are used throughout the service layer.

---

## 9. Core Library Utilities

These are the most critical files. All business logic depends on them.

---

### 9.1 `/lib/decimal.ts`

Wrap all decimal.js operations. Never accept raw JS numbers. Always return Decimal instances. Serialize to string before DB write.

```
toDecimal(value: string | number): Decimal
calcPure(quantity: string, purity: string): Decimal
  — quantity × (purity / 100)

calcWastagePercent(baseWeight: string, wastagePercent: string, touchPercent: string): Decimal
  — baseWeight × (wastagePercent / touchPercent)

calcWastageGram(baseWeight: string, wastageGram: string): Decimal
  — baseWeight × wastageGram

calcTotalWeight(weight: string, stone: string, throde: string, wastage: string): Decimal
  — weight - (stone + throde) + wastage

calcTotalPure(totalWeight: string, touchPercent: string): Decimal
  — totalWeight / touchPercent × 100

calcAverageTouch(totalPure: string, weight: string): Decimal
  — totalPure / weight × 100

calcAmount(quantity: string, rate: string): Decimal
  — quantity × rate

sumDecimals(values: string[]): Decimal
subtractDecimals(a: string, b: string): Decimal
multiplyDecimals(a: string, b: string): Decimal
divideDecimals(a: string, b: string): Decimal
```

---

### 9.2 `/lib/balance.ts`

The single most important query function in the entire system.

```
getBalance(db, {
  accountId: string,
  itemId: string,
  asOfDate?: Date
}): Promise<Decimal>
```

Implementation:

- Query 1: `SELECT COALESCE(SUM(quantity), 0) FROM entries WHERE to_account_id = accountId AND item_id = itemId [AND created_at <= asOfDate]` → inflows
- Query 2: `SELECT COALESCE(SUM(quantity), 0) FROM entries WHERE from_account_id = accountId AND item_id = itemId [AND created_at <= asOfDate]` → outflows
- Return `subtractDecimals(inflows, outflows)` using decimal.ts
- This function works identically for gold grams, ornament pieces, and rupees

```
getBalances(db, {
  accountId: string,
  itemIds: string[],
  asOfDate?: Date
}): Promise<Record<string, Decimal>>
```

Batch version — runs multiple getBalance calls in parallel using Promise.all. Used in dashboard.

---

### 9.3 `/lib/entryBuilder.ts`

The only function that writes to the ledger. Used everywhere.

```
createEntryGroup(db, {
  type: EntryGroupType,
  accountId: string,
  date: string,
  billNo?: number,
  ratePerGram?: string,
  remarks?: string,
  reversalOf?: string,
  entries: [{
    fromAccountId: string,
    toAccountId: string,
    itemId: string,
    quantity: string,
    purity?: string,
    wastageMode?: WastageMode,
    wastageValue?: string,
    rate?: string,
    amount?: string,
    remarks?: string
  }]
}): Promise<{ group: EntryGroup, entries: Entry[] }>
```

Implementation — all inside a single `db.transaction()`:

- Generate `entry_no` for the group using `generateEntryNo`
- Insert `entry_groups` row
- For each entry input:
  - If `purity` provided: compute `pure_quantity = calcPure(quantity, purity)`
  - If `wastageMode = PERCENT`: compute `wastage_quantity = calcWastagePercent(base, wastageValue, purity)`
  - If `wastageMode = GRAM`: compute `wastage_quantity = calcWastageGram(base, wastageValue)`
  - Insert `entries` row with all computed values
- If any step fails: full rollback
- Return created group and entries

---

### 9.4 `/lib/reversal.ts`

```
reverseEntryGroup(db, originalGroupId: string): Promise<EntryGroup>
```

Implementation — inside a single `db.transaction()`:

- Fetch original `entry_group` row
- Verify `reversed_by` is null — if not null throw CONFLICT: "Transaction already reversed"
- Fetch all `entries` where `group_id = originalGroupId`
- Call `createEntryGroup` with:
  - `type: REVERSAL`
  - `reversalOf: originalGroupId`
  - Same `accountId`, `date`, `ratePerGram`
  - Each entry: swap `fromAccountId` and `toAccountId`, keep all other fields identical
- Update original group: set `reversed_by = newGroup.id`
- Soft delete original `entry_group`: set `is_deleted = true`
- Return new reversal group

---

### 9.5 `/lib/entryNo.ts`

```
generateEntryNo(db, tx, tableName: string): Promise<number>
```

- Runs inside caller's existing transaction (`tx` parameter)
- `SELECT COALESCE(MAX(entry_no), 0) + 1 FROM {table}`
- Returns the number

---

### 9.6 `/lib/permissions.ts`

```
checkPermission(db, userId: string, module: string, form: string, action: 'view' | 'edit' | 'delete'): Promise<boolean>
```

- Queries `user_form_permissions` for module + form access
- Queries `user_activity_permissions` for the specific action
- Returns false if either check fails
- Cache per request only — never globally

---

## 10. Authentication

### `/src/config/jwt.ts`

```
signToken(payload: { id: string, username: string, user_group: string }): string
verifyToken(token: string): { id, username, user_group }
```

- Uses `JWT_SECRET` from env
- Expiry: `JWT_EXPIRES_IN` from env (8h)
- `verifyToken` throws if invalid or expired

### Auth Routes (mounted at `/api/auth`)

`POST /api/auth/login`

- Input: `{ username: string, password: string }`
- Find user by username where `is_deleted = false`
- bcrypt compare password against `password_hash`
- If invalid: return 401 `{ code: "UNAUTHORIZED", message: "Invalid username or password" }`
- If valid: return `{ token: signToken({ id, username, user_group }) }`

`POST /api/auth/logout`

- No server action needed — client discards token
- Return `{ success: true }`

`GET /api/auth/me`

- Read `Authorization: Bearer <token>` header
- `verifyToken` — return 401 if invalid
- Return user object without password_hash

### Auth Middleware

```
authMiddleware: trpc middleware
```

- Read Authorization header
- Call `verifyToken`
- Attach decoded payload to `ctx.user`
- Return 401 if missing or invalid

### Permission Middleware

```
permissionMiddleware(module: string, form: string, action: string): trpc middleware
```

- Runs after authMiddleware
- Calls `checkPermission(db, ctx.user.id, module, form, action)`
- Returns 403 if false

---

## 11. trpc Setup

### Base Procedures

```
publicProcedure     — no auth
protectedProcedure  — requires valid JWT (authMiddleware applied)
guardedProcedure(module, form, action) — requires JWT + permission check
```

### Router Tree

```
appRouter
  ├── dashboard
  ├── notifications
  ├── items (gold types + ornaments combined)
  ├── accounts (customers + goldsmiths + employees combined)
  ├── transactions
  │   ├── purchase
  │   ├── sales
  │   ├── jobWork
  │   └── labourBill
  ├── stock
  ├── expense
  └── settings
      ├── users
      ├── permissions
      ├── company
      └── backup
```

Mount at `/api/rpc`.

---

## 12. Module-by-Module API and Business Logic

---

### 12.1 Items Module

Covers gold types and ornament types from the original UI screens.

`items.list`

- Input: `{ type?: 'GOLD' | 'ORNAMENT' | 'MONEY', page: number, limit: number, search?: string }`
- Query items where `is_deleted = false`, filter by type if provided
- Order by `entry_no ASC`
- Return `{ data: Item[], total: number }`

`items.create`

- Input: `{ name: string, type: 'GOLD' | 'ORNAMENT', unit: 'GRAM' | 'PIECE' }`
- Check uniqueness: `SELECT id FROM items WHERE name ILIKE ? AND type = ? AND is_deleted = false`
- If exists: throw CONFLICT
- Generate `entry_no`
- Insert

`items.update`

- Input: `{ id: string, name: string }`
- Check uniqueness excluding self
- Update `name` and `updated_at`
- Name change does not affect historical entries — FK is id

`items.delete`

- Input: `{ id: string }`
- Check: `SELECT id FROM entries WHERE item_id = ? LIMIT 1`
- If referenced: throw BUSINESS_RULE_VIOLATION: "Item is in use and cannot be deleted"
- Soft delete

---

### 12.2 Accounts Module

Covers customers, goldsmiths, and employees from original UI.

`accounts.list`

- Input: `{ type?: AccountType, customer_type?: CustomerType, page, limit, search? }`
- Filter by type for different screens (customer screen filters CUSTOMER type, employee screen filters GOLDSMITH type)
- Return `{ data: Account[], total: number }`

`accounts.create`

- Input:
  ```
  {
    name: string,
    type: AccountType,
    customer_type?: CustomerType,
    gst_no?: string,
    pan_no?: string,
    state_code?: string,
    place_of_supply?: string,
    address?: string,
    phone?: string,
    email?: string,
    website?: string,
    opening_pure_balance?: string,   — decimal string
    opening_cash_balance?: string    — decimal string
  }
  ```
- Validate GST format if provided: 15-char alphanumeric
- Validate PAN format if provided: 10-char alphanumeric
- Generate `entry_no`
- Inside a single DB transaction:
  - Insert account row
  - If `opening_pure_balance > 0`: call `createEntryGroup` with type OPENING:
    - Entry: `{ from: SHOP_ID, to: newAccount.id, item: RUPEE_ID equivalent gold item, quantity: opening_pure_balance }`
    - Use the primary GOLD item id for opening pure balance
  - If `opening_cash_balance > 0`: call `createEntryGroup` with type OPENING:
    - Entry: `{ from: CASH_ID, to: newAccount.id, item: RUPEE_ITEM_ID, quantity: opening_cash_balance }`

`accounts.update`

- Input: Full account object + `updated_at` for optimistic locking
- Fetch current `updated_at` from DB
- If submitted `updated_at` does not match DB value: throw CONFLICT: "Record was modified by another user"
- Update account row
- Opening balance field changes do NOT retroactively change ledger entries — document this in code comment

`accounts.delete`

- Input: `{ id: string }`
- Block if `is_system_account = true`: throw BUSINESS_RULE_VIOLATION: "System accounts cannot be deleted"
- Check: `SELECT id FROM entry_groups WHERE account_id = ? AND is_deleted = false LIMIT 1`
- If referenced: throw BUSINESS_RULE_VIOLATION: "Account has transaction history and cannot be deleted"
- Soft delete

`accounts.getBalance`

- Input: `{ accountId: string, itemId: string }`
- Call `getBalance(db, { accountId, itemId })`
- Return `{ balance: string }` — serialized decimal string

---

### 12.3 Purchase Module

`transactions.purchase.list`

- Input: `{ page, limit, search?, from_date?, to_date? }`
- Query `entry_groups` where `type = PURCHASE` and `is_deleted = false`
- Join with `accounts` for supplier name
- Filter by date range if provided
- Return paginated list with all history table columns

`transactions.purchase.getById`

- Input: `{ id: string }`
- Fetch `entry_group` row
- Fetch all `entries` where `group_id = id`
- Separate gold entries (item type GOLD) from ornament entries (item type ORNAMENT) from money entries (item type MONEY)
- Return structured object for form prepopulation

`transactions.purchase.create`

- Input:
  ```
  {
    account_id: string,        — supplier account id
    date: string,              — ISO date
    rate_per_gram: string,     — decimal string
    remarks?: string,
    gold_items: [{
      item_id: string,
      quantity: string,        — weight in grams, decimal string
      purity: string           — touch percentage, decimal string
    }],
    ornament_items: [{
      item_id: string,
      quantity: string,
      purity: string
    }],
    bank_amount: string,       — decimal string
    bank_details?: string,
    discount?: string          — decimal string
  }
  ```

**Calculations (all using decimal.ts, all before createEntryGroup call):**

Step 1 — Per item pure calculation:

```
For each gold item:
  pure_quantity = calcPure(item.quantity, item.purity)
  — stores on entry row

For each ornament item:
  pure_quantity = calcPure(item.quantity, item.purity)
```

Step 2 — Totals:

```
total_pure = sumDecimals([...all item pure_quantities])
total_pure_value_cash = calcAmount(total_pure, rate_per_gram)
```

Step 3 — Opening balance from ledger:

```
opening_pure = getBalance(db, { accountId: account_id, itemId: primaryGoldItemId })
opening_cash = getBalance(db, { accountId: account_id, itemId: RUPEE_ITEM_ID })
```

Step 4 — Total balance:

```
total_balance = subtractDecimals(
  subtractDecimals(opening_cash, total_pure_value_cash),
  bank_amount
)
— Note: opening_cash - total_pure_value_cash + bank_amount
— bank_amount is money paid TO supplier so it reduces what supplier is owed
```

Step 5 — Bill number per supplier:

```
bill_no = SELECT COALESCE(MAX(bill_no), 0) + 1
          FROM entry_groups
          WHERE account_id = account_id AND type = 'PURCHASE' AND is_deleted = false
```

Step 6 — Call `createEntryGroup` with type PURCHASE:

```
entries: [
  for each gold item:
    { from: account_id, to: SHOP_ID, item: item.item_id, quantity: item.quantity, purity: item.purity }
  for each ornament item:
    { from: account_id, to: SHOP_ID, item: item.item_id, quantity: item.quantity, purity: item.purity }
  money entry:
    { from: SHOP_ID, to: account_id, item: RUPEE_ITEM_ID, quantity: bank_amount }
]
```

`transactions.purchase.update`

- Input: same as create + `{ id: string }`
- Inside one DB transaction:
  - Call `reverseEntryGroup(db, id)` — this reverses all ledger effects of original
  - Call purchase create service logic with new data
- Both steps inside same outer DB transaction

`transactions.purchase.delete`

- Input: `{ id: string }`
- Call `reverseEntryGroup(db, id)`
- This automatically soft deletes the original and creates reversal entries

---

### 12.4 Sales Module

`transactions.sales.list` — same pattern as purchase list, type = SALE

`transactions.sales.getById` — same pattern as purchase getById

`transactions.sales.create`

- Input:
  ```
  {
    account_id: string,        — customer account id
    date: string,
    rate_per_gram: string,
    remarks?: string,
    items: [{
      item_id: string,
      quantity: string,        — weight in grams
      purity: string,          — touch percentage
      wastage_mode: 'PERCENT' | 'GRAM',
      wastage_value: string    — percent or gram value
    }],
    bank_amount: string,       — money received from customer
    bank_details?: string
  }
  ```

**Calculations (all using decimal.ts):**

Step 1 — Per item wastage and pure calculation:

```
For each item:
  base_weight = quantity  — (stone + throde + chain if applicable, else just quantity)

  If wastage_mode = PERCENT:
    wastage_quantity = calcWastagePercent(base_weight, wastage_value, purity)
    — base_weight × (wastage_value / purity)

  If wastage_mode = GRAM:
    wastage_quantity = calcWastageGram(base_weight, wastage_value)
    — base_weight × wastage_value

  total_quantity = toDecimal(quantity).plus(wastage_quantity)
  pure_quantity = calcPure(total_quantity, purity)
  — (quantity + wastage) × (purity / 100)
```

Step 2 — Totals:

```
total_pure = sumDecimals([...all item pure_quantities])
total_pure_value_cash = calcAmount(total_pure, rate_per_gram)
```

Step 3 — Opening balance from ledger:

```
opening_pure = getBalance(db, { accountId: account_id, itemId: primaryGoldItemId })
opening_cash = getBalance(db, { accountId: account_id, itemId: RUPEE_ITEM_ID })
```

Step 4 — Total balance:

```
total_balance = toDecimal(opening_cash)
  .plus(total_pure_value_cash)
  .minus(bank_amount)
— customer owes more as we sell to them, minus what they paid
```

Step 5 — Stock validation (before createEntryGroup):

```
For each item being sold:
  available = getBalance(db, { accountId: SHOP_ID, itemId: item.item_id })
  if available < toDecimal(item.quantity):
    throw BUSINESS_RULE_VIOLATION: "Insufficient stock for item {item_name}"
Use SELECT ... FOR UPDATE on entries for this item to prevent race conditions
```

Step 6 — Bill number per customer:

```
bill_no = SELECT COALESCE(MAX(bill_no), 0) + 1
          FROM entry_groups
          WHERE account_id = account_id AND type = 'SALE' AND is_deleted = false
```

Step 7 — Call `createEntryGroup` with type SALE:

```
entries: [
  for each item:
    {
      from: SHOP_ID,
      to: account_id,
      item: item.item_id,
      quantity: total_quantity,   — quantity + wastage
      purity: item.purity,
      wastageMode: item.wastage_mode,
      wastageValue: item.wastage_value
    }
  money entry:
    { from: account_id, to: SHOP_ID, item: RUPEE_ITEM_ID, quantity: bank_amount }
]
```

`transactions.sales.update`

- Inside one DB transaction:
  - `reverseEntryGroup(db, id)`
  - Re-run sales create service with new data including stock validation

`transactions.sales.delete`

- `reverseEntryGroup(db, id)`

---

### 12.5 Job Work Module

`transactions.jobWork.list` — type = JOB_WORK

`transactions.jobWork.getById`

- Return entry group with entries split into four arrays:
  - gold entries where from = SHOP (gold issue)
  - gold entries where to = SHOP (gold receipt)
  - ornament entries where from = SHOP (ornament issue)
  - ornament entries where to = SHOP (ornament receipt)

`transactions.jobWork.create`

- Input:
  ```
  {
    account_id: string,     — goldsmith account id
    date: string,
    remarks?: string,
    gold_issue: [{
      item_id: string,
      quantity: string,
      purity: string,
      actual_purity?: string
    }],
    ornament_issue: [{
      item_id: string,
      quantity: string,
      purity: string,
      stone?: string,
      throde?: string,
      chain?: string,
      wastage_mode: 'PERCENT' | 'GRAM',
      wastage_value: string
    }],
    gold_receipt: [{
      item_id: string,
      quantity: string,
      purity: string
    }],
    ornament_receipt: [{
      item_id: string,
      quantity: string,
      purity: string,
      stone?: string,
      throde?: string,
      chain?: string,
      wastage_mode: 'PERCENT' | 'GRAM',
      wastage_value: string
    }]
  }
  ```

**Calculations (all using decimal.ts):**

Step 1 — For each ornament item in issue and receipt:

```
stone = item.stone ?? '0'
throde = item.throde ?? '0'
chain = item.chain ?? '0'

base_weight = subtractDecimals(
  subtractDecimals(item.quantity, stone),
  throde
)
— weight - stone - throde (chain is deducted separately per business rule)

If wastage_mode = PERCENT:
  wastage_quantity = calcWastagePercent(base_weight, item.wastage_value, item.purity)
  — base_weight × (wastage_value / purity)

If wastage_mode = GRAM:
  wastage_quantity = calcWastageGram(base_weight, item.wastage_value)
  — base_weight × wastage_value

total_weight = calcTotalWeight(item.quantity, stone, throde, wastage_quantity)
— weight - (stone + throde) + wastage

total_pure = calcTotalPure(total_weight, item.purity)
— total_weight / purity × 100

average_touch = calcAverageTouch(total_pure, item.quantity)
— total_pure / weight × 100
```

Step 2 — Opening balance (goldsmith's current gold balance):

```
opening_balance = getBalance(db, { accountId: account_id, itemId: primaryGoldItemId })
```

Step 3 — Call `createEntryGroup` with type JOB_WORK containing all entries:

```
For each gold_issue item:
  { from: SHOP_ID, to: account_id, item: item.item_id, quantity: item.quantity, purity: item.purity }

For each ornament_issue item:
  {
    from: SHOP_ID,
    to: account_id,
    item: item.item_id,
    quantity: total_weight,    — computed above
    purity: item.purity,
    wastageMode: item.wastage_mode,
    wastageValue: item.wastage_value
  }

For each gold_receipt item:
  { from: account_id, to: SHOP_ID, item: item.item_id, quantity: item.quantity, purity: item.purity }

For each ornament_receipt item:
  {
    from: account_id,
    to: SHOP_ID,
    item: item.item_id,
    quantity: total_weight,
    purity: item.purity,
    wastageMode: item.wastage_mode,
    wastageValue: item.wastage_value
  }

For each wastage entry (from ornament items):
  { from: account_id, to: LOSS_ID, item: gold_item_id, quantity: wastage_quantity }
```

Step 4 — Slip balance and final balance (read from ledger after write):

```
slip_balance = getBalance(db, { accountId: account_id, itemId: primaryGoldItemId })
— automatically = all issued gold - all received gold, no manual calculation

final_balance = slip_balance
— same query, the ledger gives you the running total
```

`transactions.jobWork.update`

- `reverseEntryGroup(db, id)` then recreate

`transactions.jobWork.delete`

- `reverseEntryGroup(db, id)`

---

### 12.6 Labour Bill Module

`transactions.labourBill.list` — type = LABOUR_BILL

`transactions.labourBill.getById` — return group with entries

`transactions.labourBill.create`

- Input:
  ```
  {
    account_id: string,     — goldsmith/labour account id
    date: string,
    rate_per_gram: string,
    item_type: string,
    type: string,
    remarks?: string,
    items: [{
      item_id: string,
      quantity: string,
      purity: string
    }],
    bank_paid?: string,     — cash paid to worker
    bank_receive?: string   — cash received from worker
  }
  ```

**Calculations:**

Step 1 — Per item:

```
pure_quantity = calcPure(item.quantity, item.purity)
```

Step 2 — Totals:

```
new_value_pure = sumDecimals([...all item pure_quantities])
new_value_cash = calcAmount(new_value_pure, rate_per_gram)
```

Step 3 — Balances from ledger:

```
balance_pure = getBalance(db, { accountId: account_id, itemId: primaryGoldItemId })
balance_cash = getBalance(db, { accountId: account_id, itemId: RUPEE_ITEM_ID })
```

Step 4 — Call `createEntryGroup` with type LABOUR_BILL:

```
For each item:
  { from: account_id, to: SHOP_ID, item: item.item_id, quantity: item.quantity, purity: item.purity }

If bank_paid > 0:
  { from: SHOP_ID, to: account_id, item: RUPEE_ITEM_ID, quantity: bank_paid }

If bank_receive > 0:
  { from: account_id, to: SHOP_ID, item: RUPEE_ITEM_ID, quantity: bank_receive }
```

`transactions.labourBill.update` — reverse + recreate
`transactions.labourBill.delete` — reverseEntryGroup

---

### 12.7 Stock Module

All stock is read-only — derived from entries. No writes here.

`stock.getSummary`

```
gold_total_pure = getBalance(db, { accountId: SHOP_ID, itemId: each_gold_item_id })
— run for all gold items, sum results

ornaments_count = COUNT of ornament items where getBalance > 0 for SHOP account

mc_gold_total = SUM of getBalance for all GOLDSMITH accounts for gold items
— gold currently held by all goldsmiths
```

Run all in parallel with Promise.all.

`stock.getGoldStock`

- Input: `{ page, limit }`
- For each gold item: compute `getBalance(db, { accountId: SHOP_ID, itemId: item.id })`
- Return items with non-zero balance, paginated
- Include source entries joined with entry_group for history display

`stock.getOrnamentStock`

- Same pattern for ornament items in SHOP account

`stock.getMcGoldStock`

- Query all GOLDSMITH accounts
- For each goldsmith: `getBalance(db, { accountId: goldsmith.id, itemId: each_gold_item_id })`
- Return goldsmiths with non-zero gold balance

---

### 12.8 Dashboard Module

`dashboard.getMetrics`

- Input: `{ range: 'today' | 'week' | 'month' | 'custom', from_date?: string, to_date?: string }`

Compute date range from input first, then run all queries in parallel with Promise.all:

```
total_sales:
  SUM(quantity) FROM entries
  JOIN entry_groups ON group_id
  WHERE entry_groups.type = 'SALE'
  AND to_account_id = SHOP_ID
  AND item type = MONEY
  AND entry_groups.date BETWEEN from_date AND to_date
  AND entry_groups.is_deleted = false

total_purchase:
  SUM(pure_quantity) FROM entries
  JOIN entry_groups ON group_id
  WHERE entry_groups.type = 'PURCHASE'
  AND to_account_id = SHOP_ID
  AND item type = GOLD
  AND date range

total_stock_sales:
  SUM(quantity) FROM entries
  JOIN entry_groups ON group_id
  WHERE entry_groups.type = 'SALE'
  AND from_account_id = SHOP_ID
  AND date range

total_job_work:
  COUNT(*) FROM entry_groups
  WHERE type = 'JOB_WORK'
  AND is_deleted = false
  AND date range

total_labour_bill:
  SUM(pure_quantity) FROM entries
  JOIN entry_groups ON group_id
  WHERE entry_groups.type = 'LABOUR_BILL'
  AND date range

total_expense:
  SUM(quantity) FROM entries
  JOIN entry_groups ON group_id
  WHERE entry_groups.type = 'EXPENSE'
  AND date range
```

`dashboard.getNotifications`

- Return latest 5 from `notifications` ordered by `created_at DESC` where `is_deleted = false`

---

### 12.9 Expense Module

`expense.list`

- Input: `{ page, limit, search? }`
- Query EXPENSE type entry_groups
- Join with accounts for recipient name
- Return `{ data, total, summary: { total_bills, total_value } }`
- `total_value` = SUM of money entry quantities from EXPENSE groups

`expense.create`

- Input: `{ date: string, name: string, amount: string, reason: string }`
- Find or create account with type EXPENSE and name matching input name
- Generate bill_no for expenses (global sequence)
- Call `createEntryGroup` with type EXPENSE:
  ```
  entries: [
    { from: CASH_ID, to: expense_account_id, item: RUPEE_ITEM_ID, quantity: amount }
  ]
  ```
- Set `remarks = reason`

`expense.update` — reverse + recreate
`expense.delete` — `reverseEntryGroup`

---

### 12.10 Notifications Module

`notifications.list`

- Input: `{ page, limit, search? }`
- Paginated, `created_at DESC`, `is_deleted = false`

`notifications.create`

- Input: `{ message: string }`
- Generate `entry_no`
- Set `created_by = ctx.user.id`

`notifications.delete`

- Input: `{ id: string }`
- Soft delete only

---

### 12.11 Settings — Users Module

`settings.users.list` — return all users, never return `password_hash`

`settings.users.create`

- Input: `{ username: string, user_group: string, password: string }`
- Hash password with bcrypt (cost factor 12)
- Generate `entry_no`
- Insert

`settings.users.changePassword`

- Input: `{ id: string, new_password: string, confirm_password: string }`
- Validate passwords match
- Hash and update

`settings.users.delete`

- Soft delete only

---

### 12.12 Settings — Permissions Module

`settings.permissions.getFormPermissions`

- Input: `{ userId: string }`
- Return full permission map grouped by module

`settings.permissions.saveFormPermissions`

- Input: `{ userId: string, permissions: [{ module, form_name, allowed }] }`
- Upsert each row

`settings.permissions.getActivityPermissions`

- Input: `{ userId: string }`
- Return `{ can_view, can_edit, can_delete }`

`settings.permissions.saveActivityPermissions`

- Input: `{ userId: string, can_view: boolean, can_edit: boolean, can_delete: boolean }`
- Upsert

---

### 12.13 Settings — Company Module

`settings.company.get` — fetch single row
`settings.company.update` — upsert single row

---

### 12.14 Settings — Backup Module

`settings.backup.create`

- Input: `{ from_date: string, to_date: string, modules: string[], format: 'JSON' }`
- Query selected module data filtered by date range
- Write to `/backups/backup_{timestamp}.json`
- Return `{ success: true, filename }`
- Note PDF export as future enhancement

---

## 13. Error Handling

### Error Types (`/types/errors.ts`)

```
VALIDATION_ERROR    → 400
NOT_FOUND          → 404
UNAUTHORIZED       → 401
FORBIDDEN          → 403
CONFLICT           → 409
BUSINESS_RULE_VIOLATION → 422
INTERNAL_ERROR     → 500
```

### Error Response Shape

```
{
  code: ErrorType,
  message: string,
  field?: string
}
```

### Global Error Middleware

Last middleware in `app.ts`. Maps thrown errors to HTTP status codes. Never exposes stack traces in production.

---

## 14. Zod Validation Conventions

- All weight/pure/touch/quantity fields: `z.string()` — decimal strings passed to decimal.js
- All monetary amounts: `z.string()` — decimal strings
- All dates: `z.string().date()` — ISO YYYY-MM-DD
- All UUIDs: `z.string().uuid()`
- All enums: `z.enum([...])` matching pgEnum definitions exactly
- Pagination: `{ page: z.number().int().min(1), limit: z.number().int().min(1).max(100) }`
- Never use `z.number()` for any gold weight or financial field

---

## 15. Project Setup — Step by Step

### 15.1 Initialize

```
bun init
— entry point: src/index.ts
— add "type": "module" to package.json
```

### 15.2 Install Dependencies

Production:

```
express @trpc/server drizzle-orm postgres
better-auth decimal.js zod bcryptjs dotenv cors helmet uuid jsonwebtoken
```

Remove `better-auth` — not used. Install:

```
jsonwebtoken @types/jsonwebtoken
```

Dev:

```
drizzle-kit @types/express @types/bcryptjs typescript bun-types
```

### 15.3 Environment Variables

```
DATABASE_URL=postgresql://user:password@localhost:5432/gold_billing
JWT_SECRET=<random 64 char string>
JWT_EXPIRES_IN=8h
NODE_ENV=development
PORT=3000
BCRYPT_ROUNDS=12
```

Validate all at startup using Zod in `/src/config/env.ts`. Server refuses to start if any are missing.

### 15.4 TypeScript Path Aliases

In `tsconfig.json`:

```
"@/*": ["./src/*"]
```

All internal imports use `@/` prefix. Never use relative `../../` paths.

### 15.5 Express App Setup Order

```
1. helmet()
2. cors()
3. express.json({ limit: '10mb' })
4. express.urlencoded({ extended: true })
5. Auth routes at /api/auth
6. trpc router at /api/trpc
7. GET /health → { status: 'ok', timestamp }
8. 404 handler
9. Global error middleware (last)
```

---

## 16. Migration Order

Create and apply in this sequence:

```
1. items
2. accounts
3. entry_groups
4. entries
5. users
6. user_form_permissions
7. user_activity_permissions
8. notifications
9. print_templates
10. company_details
```

Run seed script after all migrations.

---

## 17. Development Sequence

### Phase 1 — Infrastructure

1. Env config and validation
2. DB client and all schema files
3. Run migrations and seed
4. All `/lib` utilities: decimal, balance, entryBuilder, reversal, entryNo, permissions
5. JWT config and auth routes
6. Auth middleware
7. Permission middleware (stub with allow-all initially)
8. Express app setup
9. Global error handler
10. Health check

**Gate:** Server starts, `/health` returns 200, login returns JWT, `/api/auth/me` returns user.

### Phase 2 — Core Ledger Validation

Before building any business module:

- Manually call `createEntryGroup` in a test script
- Verify entries are written correctly
- Call `getBalance` and verify correct value returned
- Call `reverseEntryGroup` and verify balance returns to zero

**Gate:** All three ledger functions work correctly in isolation.

### Phase 3 — Items and Accounts

1. Items CRUD
2. Accounts CRUD with opening balance ledger writes

**Gate:** Create account with opening balance → two OPENING entry groups exist in DB → `getBalance` for that account returns the opening value.

### Phase 4 — Transaction Modules

In order:

1. Purchase
2. Sales (with stock validation)
3. Job Work
4. Labour Bill

**Gate per module:**

- Create → verify ledger balances changed correctly
- Update → verify old entries reversed, new entries applied
- Delete → verify balances returned to pre-transaction state

### Phase 5 — Read Modules

1. Stock summary and detail views
2. Dashboard metrics
3. Expense
4. Notifications

### Phase 6 — Settings

1. Company details
2. Users CRUD
3. Form permissions
4. Activity permissions
5. Backup

### Phase 7 — Permission Hardening

- Replace permission middleware stub with full implementation
- Wire `guardedProcedure` with correct module + form + action on every procedure
- Test all permission scenarios

### Phase 8 — Final Audit

- Verify zero instances of JS native arithmetic on weights or financial values
- Verify all list queries filter `is_deleted = false`
- Verify entries table has zero UPDATE or DELETE operations anywhere
- Verify `SELECT ... FOR UPDATE` used in sales stock validation
- Verify no stack traces exposed in production error responses

---

## 18. Validation Checklist

### Infrastructure

- [ ] Server starts with `bun run dev`
- [ ] `/health` returns 200
- [ ] Missing env variable causes startup failure with clear message
- [ ] `POST /api/auth/login` returns JWT token
- [ ] `GET /api/auth/me` with valid token returns user
- [ ] Protected procedure without token returns 401
- [ ] Procedure without form permission returns 403

### Database

- [ ] All 10 tables exist after migrations
- [ ] All FK constraints in place
- [ ] All indexes created
- [ ] Entries table has no `is_deleted` column
- [ ] All quantity columns are NUMERIC(20,8)
- [ ] All amount columns are NUMERIC(20,2)
- [ ] System accounts and RUPEE item exist after seed

### Ledger Core

- [ ] `createEntryGroup` is atomic — partial failure rolls back all entries
- [ ] `getBalance` returns correct net for any account/item combination
- [ ] `reverseEntryGroup` swaps from/to and marks original as reversed
- [ ] Entries table has zero UPDATE or DELETE operations anywhere in codebase
- [ ] `reverseEntryGroup` throws CONFLICT if transaction already reversed

### Purchase

- [ ] Create → SHOP gold balance increases by total pure quantity
- [ ] Create → supplier cash balance increases by bank_amount
- [ ] Update → original reversed, new entries correct
- [ ] Delete → SHOP gold balance returns to pre-purchase value
- [ ] Bill number increments per supplier not globally

### Sales

- [ ] Stock check prevents sale when SHOP balance < quantity
- [ ] Stock check uses SELECT FOR UPDATE
- [ ] Create → SHOP ornament/gold balance decreases
- [ ] Create → SHOP cash balance increases by bank_amount
- [ ] Wastage stored on entry row correctly

### Job Work

- [ ] Gold issued → SHOP gold decreases, goldsmith balance increases
- [ ] Ornament received → SHOP ornament increases
- [ ] Wastage → LOSS account balance increases
- [ ] Slip balance = `getBalance(goldsmith, gold)` automatically correct
- [ ] All wastage calculations use decimal.ts functions

### Stock

- [ ] All stock values derived from entries — zero direct stock table queries
- [ ] MC gold = sum of gold held by GOLDSMITH type accounts
- [ ] Stock at past date works using `asOfDate` parameter

### Precision

- [ ] All quantities NUMERIC(20,8)
- [ ] Zero JS native arithmetic on weights or financials
- [ ] decimal.js used for every calculation
- [ ] Results serialized to string before DB write

### Security

- [ ] Passwords hashed with bcrypt cost 12
- [ ] JWT secret from env, never hardcoded
- [ ] No stack traces in production responses
- [ ] All inputs pass Zod validation before service layer
- [ ] System accounts cannot be deleted

---

## 19. Conventions

### Naming

- DB tables: `snake_case` plural
- DB columns: `snake_case`
- TypeScript variables/functions: `camelCase`
- Types/interfaces: `PascalCase`
- Zod schemas: `PascalCase` + `Schema` suffix
- Service functions: verb-first (`createPurchase`, `listAccounts`)
- Query functions: `find`, `findMany`, `insert`, `softDelete` prefix

### Rules

- No business logic in `queries.ts` — DB operations only
- No DB imports in `router.ts` — call service functions only
- No direct ledger writes outside `createEntryGroup`
- No direct `entries` reads outside `getBalance` and `queries.ts`
- Every multi-table write inside `db.transaction()`
- `entries` table: insert only, never update, never delete

---

## 20. Opening Stock Feature

### 20.1 Schema Change

Add `OPENING_STOCK` to the account type enum in the `accounts` schema alongside existing types: `SHOP | CUSTOMER | GOLDSMITH | CASH | BANK | EXPENSE | LOSS | OPENING_STOCK`

Generate and run migration after this change.

---

### 20.2 Seed Change

Add one new system account in `/src/db/seed.ts`:

```
name: 'Opening Stock'
type: OPENING_STOCK
is_system_account: true
```

Store its ID as `OPENING_STOCK_ACCOUNT_ID` in `/src/config/constants.ts` alongside `SHOP_ID`, `CASH_ID`, `BANK_ID`, `LOSS_ID`.

---

### 20.3 Procedure: `stock.addOpeningStock`

**Input schema:**

```
{
  date: z.string().date(),
  gold_items: z.array(z.object({
    item_id: z.string().uuid(),
    quantity: z.string(),
    purity: z.string()
  })).optional().default([]),
  ornament_items: z.array(z.object({
    item_id: z.string().uuid(),
    quantity: z.string()
  })).optional().default([]),
  mc_gold_items: z.array(z.object({
    account_id: z.string().uuid(),
    item_id: z.string().uuid(),
    quantity: z.string(),
    purity: z.string()
  })).optional().default([])
}
```

**Validation before service:**

- If all three arrays are empty: throw VALIDATION_ERROR: `'At least one stock item is required'`
- All quantity and purity values must be positive decimal strings greater than zero: throw VALIDATION_ERROR if any fail

**Service logic:**

Step 1 — If `gold_items` or `ornament_items` has entries: call `createEntryGroup` once with type `OPENING` containing all entries:

```
For each gold_item:
  { from: OPENING_STOCK_ACCOUNT_ID, to: SHOP_ID, item_id: item.item_id, quantity: item.quantity, purity: item.purity }

For each ornament_item:
  { from: OPENING_STOCK_ACCOUNT_ID, to: SHOP_ID, item_id: item.item_id, quantity: item.quantity }
```

Step 2 — For each `mc_gold_item`: call `createEntryGroup` separately with type `OPENING`:

```
{ from: OPENING_STOCK_ACCOUNT_ID, to: item.account_id, item_id: item.item_id, quantity: item.quantity, purity: item.purity }
```

Step 3 — Return `{ success: true }`

**Key rules:**

- This procedure has no one-time restriction — it can be called multiple times
- Each call creates a new OPENING entry group
- Stock balances accumulate correctly because stock is always derived from SUM of all ledger entries
- Access is controlled by the permission system only — restrict to admin via `guardedProcedure`
- All writes inside one DB transaction

---

### 20.4 Validation Checklist for This Feature

- [ ] `OPENING_STOCK` account exists in DB after seed
- [ ] `OPENING_STOCK_ACCOUNT_ID` constant is exported from `/src/config/constants.ts`
- [ ] Calling procedure with empty arrays throws VALIDATION_ERROR
- [ ] Calling procedure with one gold item creates one entry in entries table with `from_account = OPENING_STOCK_ACCOUNT_ID` and `to_account = SHOP_ID`
- [ ] Calling `getBalance(SHOP_ID, goldItemId)` after adding stock reflects the added quantity
- [ ] Calling procedure twice accumulates correctly — stock increases both times
- [ ] MC gold items create entries pointing to goldsmith account not SHOP account
- [ ] Non-admin user without permission receives 403
